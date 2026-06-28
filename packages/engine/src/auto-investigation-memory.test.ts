/**
 * HOR-432 — auto-create a recurrence-aware memory from EVERY investigation.
 *
 * Exercised against the embedded pglite db (so the bundled memory_item/_link/_audit migrations and the
 * incident-family signature/tags write-gate are proven end-to-end) plus an `investigate()` integration
 * pass that proves the capture is NON-BLOCKING and CONTEXT-ONLY.
 *
 * Cases:
 *   (a) an investigation creates ONE `investigation` memory with the HONEST confidence + signature/tags;
 *   (b) a RECURRING investigation (same signature/tags) LINKS via `recurs-with` and creates NO duplicate
 *       (idempotent, resync-stable edge id);
 *   (c) a genuinely different incident does NOT link;
 *   (d) a blank repo ⇒ NO memory (HOR-46 fail-closed);
 *   (e) a store error is swallowed and the investigation still returns (non-blocking);
 *   (f) the memory is never consulted by scoring (confidence is byte-identical with/without the store,
 *       and the capture touches the write/read seam only — never a status/scoring mutation).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import { createLocalDb, type HorusDb, type QueueEdge } from '@horus/db';
import { createLocalMemoryStore } from './memory.js';
import { recurrenceEdgeId } from './memory-detect.js';
import {
  autoInvestigationMemoryEnabled,
  createInvestigationMemory,
  detectRecurrence,
  linkRecurrence,
} from './auto-investigation-memory.js';
import { investigate } from './engine.js';
import type { AuditCtx, MemoryItem, MemoryStore } from './memory-store.js';
import type { InvestigationReport } from './types.js';

const actor = { kind: 'system' as const };
const audit: AuditCtx = { actor, note: 'test' };

// ---------------------------------------------------------------------------
// Minimal InvestigationReport factory (only the fields the capture path reads)
// ---------------------------------------------------------------------------

function makeReport(over: {
  repo?: string | undefined;
  hint?: string;
  confidence?: number;
  seedFile?: string;
  topCategory?: string;
  service?: string;
} = {}): InvestigationReport {
  return {
    id: 'inv_test',
    input: {
      hint: over.hint ?? 'orders are failing',
      repo: 'repo' in over ? over.repo : 'r',
      ...(over.service !== undefined ? { service: over.service } : {}),
    },
    summary: 'a deterministic summary',
    seeds: [
      {
        id: 'sym:x',
        name: 'X',
        filePath: over.seedFile ?? 'src/modules/orders/orders.service.ts',
        startLine: 1,
      },
    ],
    evidence: [],
    timeline: { boundaryCrossings: [] },
    correlation: {},
    findings: [],
    suspectedCauses: [],
    hypotheses: [
      {
        id: 'h1',
        category: over.topCategory ?? 'orders-stall',
        statement: 'the orders worker stalls on a slow downstream call',
        confidence: 0.7,
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        missingEvidence: [],
        verdict: 'supported',
        priorConfidence: 0.6,
        supportingPresent: 1,
        contradictingPresent: 0,
        rationale: 'r',
      },
    ],
    similarIncidents: [],
    gapAnalysis: { gaps: [] },
    graph: {},
    confidence: over.confidence ?? 0.42,
    nextActions: [],
  } as unknown as InvestigationReport;
}

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------

describe('autoInvestigationMemoryEnabled — default ON, explicit off disables', () => {
  const prev = process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
  afterEach(() => {
    if (prev === undefined) delete process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
    else process.env.HORUS_AUTO_INVESTIGATION_MEMORY = prev;
  });

  it('is ON when unset (every investigation creates a memory)', () => {
    delete process.env.HORUS_AUTO_INVESTIGATION_MEMORY;
    expect(autoInvestigationMemoryEnabled()).toBe(true);
  });

  it('is OFF only for an explicit 0/false/off/no escape hatch', () => {
    for (const v of ['0', 'false', 'FALSE', 'off', 'no']) {
      process.env.HORUS_AUTO_INVESTIGATION_MEMORY = v;
      expect(autoInvestigationMemoryEnabled()).toBe(false);
    }
    for (const v of ['1', 'true', 'yes', '']) {
      process.env.HORUS_AUTO_INVESTIGATION_MEMORY = v; // anything but the off-list ⇒ default-ON
      expect(autoInvestigationMemoryEnabled()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// (a)-(d) against the real local store (embedded pglite)
// ---------------------------------------------------------------------------

describe('auto-investigation-memory — local store', () => {
  let dir: string;
  let close: () => Promise<void>;
  let db: HorusDb;
  let store: MemoryStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-auto-mem-'));
    const handle = await createLocalDb({ path: join(dir, 'horus.db') });
    db = handle.db;
    close = () => handle.sql.end();
    store = createLocalMemoryStore(db);
  });
  afterEach(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) creates ONE investigation memory with the honest confidence + signature/tags', async () => {
    const report = makeReport({ confidence: 0.31, service: 'orders' });
    const mem = await createInvestigationMemory(store, 'inv_a', report, audit);

    expect(mem).not.toBeNull();
    expect(mem!.kind).toBe('investigation');
    expect(mem!.source).toBe('investigation');
    expect(mem!.scope).toBe('repo');
    expect(mem!.visibility).toBe('private');
    // HONEST confidence — the report's own value, never inflated.
    expect(mem!.confidence).toBeCloseTo(0.31, 5);
    expect(mem!.claim).toContain('Investigation:');
    expect(mem!.claim).toContain('orders are failing');
    // Incident-family recall keys persisted (NOT nulled) for the investigation kind.
    expect(mem!.signature).toBe('src/modules/orders|orders-stall|');
    expect(mem!.tags).toEqual(expect.arrayContaining(['orders-stall', 'src/modules/orders', 'orders']));

    // Exactly one investigation memory exists in the repo.
    const all = await store.query({ repo: 'r', kind: ['investigation'] });
    expect(all).toHaveLength(1);

    // about-incident link back to the source investigation (structural).
    const links = await store.links(mem!.id, { direction: 'both' });
    const back = links.find((l) => l.rel === 'about-incident' && l.toKind === 'incident');
    expect(back?.toRef).toBe('inv_a');
  });

  it('(b) a recurring investigation links via recurs-with, idempotently (no duplicate edge)', async () => {
    const first = await createInvestigationMemory(store, 'inv_a', makeReport(), audit);
    const second = await createInvestigationMemory(store, 'inv_b', makeReport(), audit);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const matchId = await detectRecurrence(store, second!, 'r');
    expect(matchId).toBe(first!.id); // same signature/tags ⇒ recurs

    await linkRecurrence(store, second!.id, first!.id, 'inv_b');
    // Re-running must NOT mint a twin (resync-stable canonical edge id dedupes).
    await linkRecurrence(store, second!.id, first!.id, 'inv_b');

    const links = await store.links(second!.id, { direction: 'both' });
    const recurs = links.filter((l) => l.rel === 'recurs-with' && l.toKind === 'memory');
    expect(recurs).toHaveLength(1);
    expect(recurs[0]!.id).toBe(recurrenceEdgeId(second!.id, first!.id));
  });

  it('(c) a genuinely different incident does NOT link', async () => {
    const orders = await createInvestigationMemory(store, 'inv_a', makeReport(), audit);
    const billing = await createInvestigationMemory(
      store,
      'inv_b',
      makeReport({
        hint: 'invoices not generated',
        seedFile: 'src/modules/billing/billing.service.ts',
        topCategory: 'billing-stuck',
      }),
      audit,
    );
    expect(orders).not.toBeNull();
    expect(billing).not.toBeNull();

    const matchId = await detectRecurrence(store, billing!, 'r');
    expect(matchId).toBeNull();
  });

  it('(d) a blank repo creates NO memory (HOR-46 fail-closed)', async () => {
    expect(await createInvestigationMemory(store, 'inv_a', makeReport({ repo: '' }), audit)).toBeNull();
    expect(await createInvestigationMemory(store, 'inv_a', makeReport({ repo: '   ' }), audit)).toBeNull();
    expect(await createInvestigationMemory(store, 'inv_a', makeReport({ repo: undefined }), audit)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (f) seam-only: the capture never touches a status/scoring mutation
// ---------------------------------------------------------------------------

describe('auto-investigation-memory — context-only seam usage (f)', () => {
  function makeItem(over: Partial<MemoryItem> = {}): MemoryItem {
    return {
      id: 'mem_new',
      kind: 'investigation',
      claim: 'Investigation: x -> y',
      scope: 'repo',
      source: 'investigation',
      evidence: [],
      confidence: 0.5,
      status: 'fresh',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastVerifiedAt: null,
      lastVerifiedHash: null,
      orgId: null,
      workspaceId: null,
      repo: 'r',
      userId: null,
      visibility: 'private',
      payload: null,
      signature: 'src/modules/orders|orders-stall|',
      tags: ['orders-stall', 'src/modules/orders'],
      ...over,
    };
  }

  function spyStore(queryResult: MemoryItem[]): MemoryStore {
    return {
      recall: vi.fn(),
      record: vi.fn(),
      loadScoped: vi.fn(),
      add: vi.fn(async (item) => makeItem({ id: 'mem_new', ...(item as Partial<MemoryItem>) })),
      get: vi.fn(),
      query: vi.fn(async () => queryResult),
      setStatus: vi.fn(),
      setVisibility: vi.fn(),
      verify: vi.fn(),
      addLink: vi.fn(async (link) => ({ ...(link as object), createdAt: new Date() })),
      removeLink: vi.fn(),
      links: vi.fn(async () => []),
      history: vi.fn(),
    } as unknown as MemoryStore;
  }

  it('createInvestigationMemory + detectRecurrence + linkRecurrence call ONLY add/addLink/query — never a status/scoring mutation', async () => {
    const prior = makeItem({ id: 'mem_prior' });
    const store = spyStore([prior]);

    const mem = await createInvestigationMemory(store, 'inv_a', makeReport(), audit);
    expect(mem).not.toBeNull();
    const existingId = await detectRecurrence(store, mem!, 'r');
    expect(existingId).toBe('mem_prior');
    await linkRecurrence(store, mem!.id, existingId!, 'inv_a');

    // Write/read seam only.
    expect(store.add).toHaveBeenCalledTimes(1);
    expect(store.query).toHaveBeenCalledWith(expect.objectContaining({ repo: 'r' }));
    expect(store.addLink).toHaveBeenCalled();
    // NEVER a status/visibility/verify/remove mutation — the capture cannot touch scoring/verdict.
    expect(store.setStatus).not.toHaveBeenCalled();
    expect(store.setVisibility).not.toHaveBeenCalled();
    expect(store.verify).not.toHaveBeenCalled();
    expect(store.removeLink).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (e)+(f) engine integration — non-blocking + scoring untouched
// ---------------------------------------------------------------------------

const FAKE_SYMBOL: Symbol = {
  id: 'sym:fake:ZohoSyncWorker',
  name: 'ZohoSyncWorker',
  filePath: 'src/workers/zoho-sync.worker.ts',
  startLine: 10,
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [FAKE_SYMBOL]; },
  async context(): Promise<SymbolContext> {
    return { symbol: FAKE_SYMBOL, callers: [], callees: [], imports: [], usesType: [], community: null, coupledWith: [] };
  },
  async impact(): Promise<ImpactResult> {
    return { target: FAKE_SYMBOL, affected: 0, byDepth: [] };
  },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> {
    return { added: [], removed: [], modified: [] };
  },
  async cypher(): Promise<CypherResult> {
    return { columns: [], rows: [], rowCount: 0 };
  },
};

function makeDb(): HorusDb {
  return {
    select() {
      return { from() { return Promise.resolve([] as QueueEdge[]); } };
    },
    insert() {
      return {
        values() {
          return { returning(): Promise<{ id: string }[]> { return Promise.resolve([{ id: 'test-id' }]); } };
        },
      };
    },
    update() {
      return { set() { return { where(): Promise<void> { return Promise.resolve(); } }; } };
    },
  } as unknown as HorusDb;
}

function noopStore(): MemoryStore {
  return {
    recall: vi.fn(async () => []),
    record: vi.fn(),
    loadScoped: vi.fn(async () => []),
    add: vi.fn(async (item) => ({
      ...(item as object),
      id: 'mem_x',
      status: 'fresh',
      createdAt: new Date(),
    })),
    get: vi.fn(),
    query: vi.fn(async () => []),
    setStatus: vi.fn(),
    setVisibility: vi.fn(),
    verify: vi.fn(),
    addLink: vi.fn(async (link) => ({ ...(link as object), createdAt: new Date() })),
    removeLink: vi.fn(),
    links: vi.fn(async () => []),
    history: vi.fn(),
  } as unknown as MemoryStore;
}

describe('auto-investigation-memory — engine integration', () => {
  it('(e) a store error is swallowed — investigate() still returns a report (non-blocking)', async () => {
    const throwing = noopStore();
    (throwing.add as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('memory store down'));

    const report = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb(), store: throwing },
    );

    expect(report).toBeDefined();
    expect(report.id).toBeTruthy();
    // The capture WAS attempted (default-ON) and its failure did not propagate.
    expect(throwing.add).toHaveBeenCalled();
  });

  it('(f) the memory is never consulted by scoring — confidence is identical with/without the store', async () => {
    const withoutStore = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb() },
    );
    const store = noopStore();
    const withStore = await investigate(
      { hint: 'zoho', repo: 'r' },
      { code: fakeCode, db: makeDb(), store },
    );

    // Adding the memory store changes nothing about the scored verdict.
    expect(withStore.confidence).toBe(withoutStore.confidence);
    // The memory WAS written (capture ran) yet it never fed back into the score.
    expect(store.add).toHaveBeenCalled();
  });
});
