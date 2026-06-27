/**
 * HOR — Tests for `horus memory show <scope>`.
 *
 * Offline: the engine renderers (renderMemoryView / memoryViewToJSON) run for real against a
 * fixture MemoryView; only the DB, connectors and the engine synthesis (buildMemoryView) are
 * mocked. We pin: project isolation (unresolved project → hard error, no DB/connectors touched),
 * the pool is always closed, scope+project are threaded into buildMemoryView, and --json stays a
 * single parseable document while the default path renders Markdown.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryView } from '@horus/engine';

const sqlEnd = vi.fn(async () => {});
const db = vi.hoisted(() => ({
  openDb: vi.fn(),
}));
const connectors = vi.hoisted(() => ({
  createConnectors: vi.fn(() => ({ code: { kind: 'fake-code' } })),
}));
const engine = vi.hoisted(() => ({
  buildMemoryView: vi.fn(),
}));

vi.mock('@horus/db', () => db);
vi.mock('@horus/connectors', () => connectors);
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return { ...actual, buildMemoryView: engine.buildMemoryView };
});

import { runMemoryShow } from './memory.js';

const dirs: string[] = [];
function writeSingleProjectConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-memory-'));
  dirs.push(dir);
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [{
    name: "my-api",
    repositories: [{ name: "my-api", path: "/repos/my-api" }],
    environments: [{ name: "production", connectors: {} }],
  }],
};
`,
    'utf8',
  );
  return path;
}

function writeMultiProjectConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), 'horus-memory-'));
  dirs.push(dir);
  const path = join(dir, 'horus.config.js');
  writeFileSync(
    path,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [
    { name: "api-a", repositories: [{ name: "api-a", path: "/repos/api-a" }], environments: [{ name: "production", connectors: {} }] },
    { name: "api-b", repositories: [{ name: "api-b", path: "/repos/api-b" }], environments: [{ name: "production", connectors: {} }] },
  ],
};
`,
    'utf8',
  );
  return path;
}

const FIXTURE: MemoryView = {
  scope: 'payments',
  project: 'my-api',
  area: 'src/payments',
  tokens: ['payments', 'checkout'],
  sourceAvailable: true,
  ownedAreas: {
    subsystems: [
      { name: 'payments', members: 24, testy: false },
      { name: 'payments-tests', members: 9, testy: true },
    ],
    seedSymbol: { name: 'PaymentService', file: 'src/payments/payment.service.ts' },
    ownership: {
      likelyMaintainer: 'alice',
      maintainerShare: 0.6,
      mostActiveRecent: 'bob',
      confidence: 0.7,
      file: 'src/payments/payment.service.ts',
      evidence: [],
    } as unknown as MemoryView['ownedAreas']['ownership'],
  },
  runtimePaths: {
    asyncBoundaries: [
      {
        queueName: 'payment-retry-queue',
        producers: [{ symbol: 'PaymentService', file: 'src/payments/payment.service.ts' }],
        workers: [{ symbol: 'PaymentRetryWorker', file: 'src/workers/payment-retry.worker.ts' }],
      },
    ],
    keyFlows: ['PaymentController → PaymentService → payment-retry-queue → PaymentRetryWorker'],
    queuesSeenInIncidents: ['payment-retry-queue'],
  },
  externalSystems: [{ name: 'stripe', files: 5 }],
  pastInvestigations: [
    {
      investigationId: 'inv-1',
      title: 'Payment retries piling up',
      summary: 'Retry queue backed up after a Stripe timeout.',
      date: '2026-06-01T00:00:00.000Z',
      overlap: 0.5,
      sharedTags: ['payments'],
      suspectedCause: { title: 'Stripe timeout', category: 'external-dependency', band: 'likely' },
      confidence: 0.74,
      confirmedProxy: true,
      sources: ['logs', 'metrics'],
    },
  ],
  recurringPatterns: [{ signature: 'src/payments|external-dependency|payment-retry-queue', count: 3 }],
  evidenceSources: {
    channels: ['logs', 'metrics'],
    alwaysAvailable: ['source-intelligence graph (code structure)', 'git history'],
  },
  weakSpots: {
    fragile: { deadCode: 3, highCouplingPairs: 7, scope: 'repo-wide' },
    testLightSubsystems: ['payments-tests'],
    lowPriorEvidence: false,
    lowPriorEvidenceReason: '',
  },
  summary:
    'Memory for "payments" in my-api: 2 owned subsystem(s), 1 queue boundary(ies), 1 external system(s), 1 past investigation(s), 1 recurring pattern(s).',
};

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  db.openDb.mockResolvedValue({ db: { fake: true }, sql: { end: sqlEnd } });
  engine.buildMemoryView.mockResolvedValue(FIXTURE);
});
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function stdout(): string {
  return logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
}

describe('runMemoryShow — project isolation (HOR-46)', () => {
  it('errors when the project cannot be resolved, touching neither connectors nor DB', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Could not resolve a project');
    expect(connectors.createConnectors).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
    expect(engine.buildMemoryView).not.toHaveBeenCalled();
  });
});

describe('runMemoryShow — synthesis path', () => {
  it('threads scope + resolved project into buildMemoryView and always closes the pool', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    expect(engine.buildMemoryView).toHaveBeenCalledWith(
      'payments',
      expect.objectContaining({ project: 'my-api', db: expect.anything(), code: expect.anything() }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('closes the pool even when synthesis throws', async () => {
    const config = writeSingleProjectConfig();
    engine.buildMemoryView.mockRejectedValueOnce(new Error('graph host unreachable'));
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(1);
    expect(sqlEnd).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('graph host unreachable');
  });

  it('renders Markdown by default', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('# Memory: payments');
    expect(out).toContain('## Owned areas');
    expect(out).toContain('payment-retry-queue');
    expect(out).toContain('Past investigations');
  });

  it('emits a single parseable JSON document under --json', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.scope).toBe('payments');
    expect(parsed.project).toBe('my-api');
    expect(parsed.pastInvestigations[0].confirmedProxy).toBe(true);
    expect(parsed.weakSpots.fragile.scope).toBe('repo-wide');
  });
});
