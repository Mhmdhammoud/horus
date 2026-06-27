/**
 * HOR — Tests for the `horus memory` command group (show/add/confirm/forget/pin/list).
 *
 * Offline: the engine renderers (renderMemoryView / memoryViewToJSON) run for real against a
 * fixture MemoryView; the DB, connectors, engine synthesis (buildMemoryView), the MemoryStore
 * (createLocalMemoryStore) and the recall layer (recallMemory) are mocked. We pin: project
 * isolation (unresolved project → hard error, no DB/connectors touched), the pool is always
 * closed, scope+project are threaded into buildMemoryView, --json stays a single parseable
 * document while the default path renders Markdown, the authored-substrate leaves route to the
 * store with the right shapes, the PII gate surfaces as a clean error, soft-forget routes to
 * `forgotten`, and confirmed-outcome stays private + linked to its investigation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MemoryView, RecalledMemory } from '@horus/engine';
import { MemorySecretError } from '@horus/engine';

const sqlEnd = vi.fn(async () => {});
const db = vi.hoisted(() => ({
  openDb: vi.fn(),
  getInvestigation: vi.fn(),
}));
const connectors = vi.hoisted(() => ({
  createConnectors: vi.fn(() => ({ code: { kind: 'fake-code' } })),
}));
const store = vi.hoisted(() => ({
  add: vi.fn(),
  addLink: vi.fn(),
  setStatus: vi.fn(),
}));
const engine = vi.hoisted(() => ({
  buildMemoryView: vi.fn(),
  createLocalMemoryStore: vi.fn(() => store),
  recallMemory: vi.fn(),
}));

vi.mock('@horus/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/db')>();
  return { ...actual, openDb: db.openDb, getInvestigation: db.getInvestigation };
});
vi.mock('@horus/connectors', () => connectors);
vi.mock('@horus/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/engine')>();
  return {
    ...actual,
    buildMemoryView: engine.buildMemoryView,
    createLocalMemoryStore: engine.createLocalMemoryStore,
    recallMemory: engine.recallMemory,
  };
});

import {
  runMemoryShow,
  runMemoryAdd,
  runMemoryConfirm,
  runMemoryForget,
  runMemoryPin,
  runMemoryList,
} from './memory.js';

/** Build a fixture RecalledMemory (what recallMemory returns) for show/list assertions. */
function recalled(over: {
  item?: Partial<RecalledMemory['item']>;
  freshness?: Partial<RecalledMemory['freshness']>;
} = {}): RecalledMemory {
  const item = {
    id: 'mem_1',
    kind: 'code-fact',
    claim: 'Payments use Stripe idempotency keys',
    scope: 'module:payments',
    source: 'human',
    evidence: [],
    confidence: 0.8,
    status: 'fresh',
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    lastVerifiedAt: null,
    lastVerifiedHash: null,
    orgId: null,
    workspaceId: null,
    repo: 'my-api',
    userId: null,
    visibility: 'private',
    payload: null,
    ...over.item,
  } as RecalledMemory['item'];
  return {
    item,
    relevance: 0,
    rank: 0.8,
    freshness: {
      status: 'fresh',
      ageDays: 5,
      verified: false,
      decay: 1,
      driftDetected: false,
      label: 'fresh',
      ...over.freshness,
    },
  };
}

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
  engine.recallMemory.mockResolvedValue([]);
  engine.createLocalMemoryStore.mockReturnValue(store);
  store.add.mockResolvedValue({ id: 'mem_new', kind: 'code-fact', scope: 'repo', visibility: 'private' });
  store.addLink.mockResolvedValue(undefined);
  store.setStatus.mockResolvedValue(undefined);
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

  it('merges PERSISTED authored items into the view, clearly sectioned (Markdown + JSON)', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config });
    expect(code).toBe(0);
    // recall is scoped to the resolved repo with the scope as the relevance text.
    expect(engine.recallMemory).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api', text: 'payments' }),
      expect.objectContaining({ limit: 50 }),
    );
    const out = stdout();
    expect(out).toContain('## Stored memory items');
    expect(out).toContain('Payments use Stripe idempotency keys');
  });

  it('carries storedItems in the --json document', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryShow('payments', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.scope).toBe('payments');
    expect(Array.isArray(parsed.storedItems)).toBe(true);
    expect(parsed.storedItems[0].id).toBe('mem_1');
    expect(parsed.storedItems[0].effectiveStatus).toBe('fresh');
  });
});

describe('runMemoryAdd', () => {
  it('routes a human claim to the store with the resolved repo + parsed evidence', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('Payments are idempotent', {
      config,
      scope: 'module:payments',
      kind: 'contract',
      evidence: ['code:src/payments/pay.ts', 'a free note'],
    });
    expect(code).toBe(0);
    expect(store.add).toHaveBeenCalledTimes(1);
    const [item, audit] = store.add.mock.calls[0]!;
    expect(item).toMatchObject({
      kind: 'contract',
      claim: 'Payments are idempotent',
      scope: 'module:payments',
      source: 'human',
      repo: 'my-api',
      confidence: 0.75,
    });
    expect(item.evidence).toEqual([
      expect.objectContaining({ kind: 'code', ref: 'src/payments/pay.ts' }),
      expect.objectContaining({ kind: 'note', ref: 'a free note' }),
    ]);
    expect(audit.actor.kind).toBe('user');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('emits clean JSON under --json', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toEqual({ ok: true, id: 'mem_new', kind: 'code-fact', scope: 'repo' });
  });

  it('rejects an unknown --kind before touching the store', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, kind: 'nonsense' });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
    expect(db.openDb).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Unknown --kind');
  });

  it('rejects an out-of-range --confidence', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('A fact', { config, confidence: '5' });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
  });

  it('surfaces the PII/secret gate as a clean error (exit 1)', async () => {
    store.add.mockRejectedValueOnce(new MemorySecretError('aws-access-key-id'));
    const config = writeSingleProjectConfig();
    const code = await runMemoryAdd('key is AKIA...', { config });
    expect(code).toBe(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('aws-access-key-id');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('errors on an unresolved project without opening the DB (HOR-46)', async () => {
    const config = writeMultiProjectConfig();
    const code = await runMemoryAdd('A fact', { config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});

describe('runMemoryConfirm — confirmed-outcome flywheel', () => {
  it('errors when the investigation is not found', async () => {
    db.getInvestigation.mockResolvedValueOnce(null);
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-x', { config });
    expect(code).toBe(1);
    expect(store.add).not.toHaveBeenCalled();
    expect(sqlEnd).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls.flat().join(' ')).toContain('Investigation not found');
  });

  it('writes a PRIVATE confirmed-outcome item and links it to the investigation', async () => {
    db.getInvestigation.mockResolvedValueOnce({
      id: 'inv-1',
      title: 'Payment retries piling up',
      summary: null,
      report: { summary: 'Stripe timeout filled the retry queue', confidence: 0.74 },
    });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config });
    expect(code).toBe(0);

    const [item] = store.add.mock.calls[0]!;
    expect(item).toMatchObject({
      kind: 'confirmed-outcome',
      source: 'confirmed-outcome',
      visibility: 'private',
      repo: 'my-api',
      confidence: 0.74,
    });
    expect(item.claim).toContain('Payment retries piling up');
    expect(item.claim).toContain('Stripe timeout filled the retry queue');

    expect(store.addLink).toHaveBeenCalledWith(
      expect.objectContaining({
        fromMemoryId: 'mem_co',
        rel: 'about-incident',
        toKind: 'incident',
        toRef: 'inv-1',
      }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('emits clean JSON under --json', async () => {
    db.getInvestigation.mockResolvedValueOnce({ id: 'inv-1', title: 'X', summary: 'done', report: null });
    store.add.mockResolvedValueOnce({ id: 'mem_co', visibility: 'private' });
    const config = writeSingleProjectConfig();
    const code = await runMemoryConfirm('inv-1', { config, json: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed).toEqual({ ok: true, id: 'mem_co', investigationId: 'inv-1', visibility: 'private' });
  });
});

describe('runMemoryForget / runMemoryPin', () => {
  it('soft-forget routes to status=forgotten (row retained, audited)', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('mem_1', { config });
    expect(code).toBe(0);
    expect(store.setStatus).toHaveBeenCalledWith(
      'mem_1',
      'forgotten',
      expect.objectContaining({ actor: { kind: 'user' } }),
    );
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('pin routes to status=pinned and emits clean JSON', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryPin('mem_1', { config, json: true });
    expect(code).toBe(0);
    expect(store.setStatus).toHaveBeenCalledWith('mem_1', 'pinned', expect.anything());
    expect(JSON.parse(stdout())).toEqual({ ok: true, id: 'mem_1', status: 'pinned' });
  });

  it('errors on a blank id without opening the DB', async () => {
    const config = writeSingleProjectConfig();
    const code = await runMemoryForget('   ', { config });
    expect(code).toBe(1);
    expect(db.openDb).not.toHaveBeenCalled();
  });
});

describe('runMemoryList', () => {
  it('lists persisted items via recall, scoped to the repo, with clean JSON', async () => {
    engine.recallMemory.mockResolvedValueOnce([recalled()]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryList({ config, json: true });
    expect(code).toBe(0);
    expect(engine.recallMemory).toHaveBeenCalledWith(
      store,
      expect.objectContaining({ repo: 'my-api', status: undefined }),
      expect.objectContaining({ limit: 200 }),
    );
    const parsed = JSON.parse(stdout());
    expect(parsed.project).toBe('my-api');
    expect(parsed.items[0].id).toBe('mem_1');
    expect(sqlEnd).toHaveBeenCalledTimes(1);
  });

  it('--all surfaces every status (incl. forgotten)', async () => {
    engine.recallMemory.mockResolvedValueOnce([]);
    const config = writeSingleProjectConfig();
    const code = await runMemoryList({ config, all: true });
    expect(code).toBe(0);
    const [, query] = engine.recallMemory.mock.calls[0]!;
    expect(query.status).toEqual(
      expect.arrayContaining(['fresh', 'forgotten', 'deprecated', 'contradicted', 'pinned', 'possibly-stale']),
    );
  });
});
