/**
 * HOR-108 — Connector failure fallback tests.
 *
 * Proves that investigations keep working when runtime connectors throw,
 * timeout, return malformed data, or are simply unavailable. All tests
 * are deterministic and service-free (mocked providers, no live sockets).
 *
 * Failure modes covered:
 *   A. Logs connector: analyzeErrors throws (service unavailable, network error)
 *   B. Logs connector: analyzeErrors returns empty analysis (no error signatures)
 *   C. Logs connector: auth/permission failure during analyzeErrors
 *   D. Queue connector: analyzeQueues throws (Redis unreachable)
 *   E. Queue connector: analyzeQueues returns empty queue list (malformed/no data)
 *   F. MongoDB state connector: analyzeState throws
 *   G. Multiple connectors fail simultaneously
 *
 * In every case:
 *   - investigate() must return a valid InvestigationReport (never throw)
 *   - Failed connector contributes no evidence
 *   - Source status or gap analysis reflects what was unavailable
 *   - No sensitive error detail leaks to the report
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { LogsProvider, LogRecord, LogAnalysis } from '@horus/connectors';
import type { MetricsProvider } from '@horus/connectors';
import type { QueueRuntimeProvider, QueueRuntimeState } from '@horus/connectors';
import type { StateProvider, StateAnalysis } from '@horus/connectors';
import type { HorusDb, QueueEdge } from '@horus/db';
import { investigate } from './engine.js';

// ---------------------------------------------------------------------------
// Shared fake code provider
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

// ---------------------------------------------------------------------------
// Shared fake DB stubs
// ---------------------------------------------------------------------------

function makeDb(edges: QueueEdge[] = []): HorusDb {
  return {
    select() {
      return {
        from(_table: unknown) {
          return Promise.resolve(edges);
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(_rows: unknown) {
          return {
            returning(_cols: unknown): Promise<{ id: string }[]> {
              return Promise.resolve([{ id: 'test-id' }]);
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(_vals: unknown) {
          return {
            where(_cond: unknown): Promise<void> {
              return Promise.resolve();
            },
          };
        },
      };
    },
  } as unknown as HorusDb;
}

const fakeDb = makeDb([]);

const FAKE_QUEUE_EDGE: QueueEdge = {
  id: 'edge-001',
  queueName: 'orders',
  producerSymbol: 'ZohoSyncWorker',
  producerFile: 'src/workers/zoho-sync.worker.ts',
  workerSymbol: 'OrderWorker',
  workerFile: 'src/workers/order.worker.ts',
  source: 'stitcher',
  project: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeDbWithQueues = makeDb([FAKE_QUEUE_EDGE]);

// ---------------------------------------------------------------------------
// Logs provider factories
// ---------------------------------------------------------------------------

const okCompat = { ok: true, indexCount: 1, issues: [] };

const baseLogsProvider: LogsProvider = {
  id: 'fake-logs',
  kind: 'logs',
  async health() { return { ok: true, detail: 'ok' }; },
  async searchLogs() { return [] as LogRecord[]; },
  async aggregateErrors() { return []; },
  async errorDeltas() { return []; },
  async analyzeErrors(): Promise<LogAnalysis> {
    return { window: { from: 'x', to: 'y' }, totalErrors: 0, signatures: [], newSignatures: [], affectedServices: [] };
  },
  async checkCompatibility() { return okCompat; },
  toEvidence() { return []; },
  async queryEvidence() { return []; },
};

// ---------------------------------------------------------------------------
// Scenario A: Logs connector throws during analyzeErrors
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario A: logs analyzeErrors throws', () => {
  const unavailableLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() {
      throw new Error('ECONNREFUSED: Elasticsearch at es.internal:9200 refused connection');
    },
  };

  it('investigate() does not throw when logs.analyzeErrors throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: unavailableLogs }),
    ).resolves.toBeDefined();
  });

  it('report has no log evidence when analyzeErrors throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    const logEv = report.evidence.filter((e) => e.kind === 'log');
    expect(logEv).toHaveLength(0);
  });

  it('logs gap is present when analyzeErrors throws (collection failed)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap!.why).toContain('failed');
  });

  it('confidence is defined and in 0–1 range even with logs failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: unavailableLogs },
    );
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario B: Logs connector returns empty analysis (no error signatures)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario B: logs analyzeErrors returns empty', () => {
  const emptyLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors(): Promise<LogAnalysis> {
      return { window: { from: 'x', to: 'y' }, totalErrors: 0, signatures: [], newSignatures: [], affectedServices: [] };
    },
  };

  it('investigate() resolves normally when analyzeErrors returns no signatures', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: emptyLogs }),
    ).resolves.toBeDefined();
  });

  it('report has no log evidence when no signatures returned', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: emptyLogs },
    );
    expect(report.evidence.filter((e) => e.kind === 'log')).toHaveLength(0);
  });

  it('logs gap reason is "no error logs matched" (not "failed") when analyzeErrors returns empty', async () => {
    // logsCollected=true but no signatures → gap with "no error logs matched" reason.
    // This is accurate: collection ran but found nothing in the window.
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: emptyLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
    expect(logsGap!.why).not.toContain('failed');
    expect(logsGap!.why).toContain('No error logs matched');
  });
});

// ---------------------------------------------------------------------------
// Scenario C: Auth/permission failure during analyzeErrors (403-like error)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario C: logs auth failure', () => {
  const authFailureLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() {
      throw new Error('ResponseError: [security_exception] missing authentication credentials');
    },
  };

  it('investigate() does not throw on auth failure', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, logs: authFailureLogs }),
    ).resolves.toBeDefined();
  });

  it('auth error message does not appear in report summary or evidence titles', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: authFailureLogs },
    );
    const allText = JSON.stringify(report);
    expect(allText).not.toContain('security_exception');
    expect(allText).not.toContain('missing authentication credentials');
  });

  it('logs gap is present after auth failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, logs: authFailureLogs },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario D: Queue connector throws during analyzeQueues (Redis unreachable)
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario D: queue analyzeQueues throws', () => {
  const throwingQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: false, detail: 'Redis unreachable' }; },
    async analyzeQueues() {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() does not throw when queue provider throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue }),
    ).resolves.toBeDefined();
  });

  it('report has no queue-state evidence when analyzeQueues throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    const queueStateEv = report.evidence.filter((e) => e.kind === 'queue-state');
    expect(queueStateEv).toHaveLength(0);
  });

  it('queue hypotheses are unconfirmed when provider throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    for (const h of report.hypotheses.filter((h) => h.category === 'queue-backlog' || h.category === 'worker-slowdown')) {
      expect(h.verdict).toBe('unconfirmed');
    }
  });

  it('connection URL does not leak into report when queue throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: throwingQueue },
    );
    expect(JSON.stringify(report)).not.toContain('127.0.0.1:6379');
  });
});

// ---------------------------------------------------------------------------
// Scenario E: Queue connector returns empty / malformed state
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario E: queue returns empty state', () => {
  const emptyQueueState: QueueRuntimeState = {
    prefix: 'bull',
    collectedAt: new Date().toISOString(),
    queues: [],
  };

  const emptyQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: true, detail: 'connected' }; },
    async analyzeQueues() { return emptyQueueState; },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() resolves normally when analyzeQueues returns no queues', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDbWithQueues, queue: emptyQueue }),
    ).resolves.toBeDefined();
  });

  it('no queue-state evidence when provider returns empty queue list', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: emptyQueue },
    );
    expect(report.evidence.filter((e) => e.kind === 'queue-state')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario F: MongoDB state connector throws
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario F: MongoDB analyzeState throws', () => {
  const throwingMongo: StateProvider = {
    id: 'mongodb',
    kind: 'state',
    async health() { return { ok: false, detail: 'MongoDB unreachable' }; },
    async analyzeState(): Promise<StateAnalysis> {
      throw new Error('MongoServerSelectionError: connect ECONNREFUSED mongo.internal:27017');
    },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() does not throw when MongoDB throws', async () => {
    await expect(
      investigate({ hint: 'zoho' }, { code: fakeCode, db: fakeDb, mongo: throwingMongo }),
    ).resolves.toBeDefined();
  });

  it('report has no state evidence when MongoDB throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(report.evidence.filter((e) => e.kind === 'state')).toHaveLength(0);
  });

  it('MongoDB connection detail does not leak into report on failure', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(JSON.stringify(report)).not.toContain('mongo.internal');
    expect(JSON.stringify(report)).not.toContain('27017');
  });

  it('report confidence is defined and valid when MongoDB throws', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDb, mongo: throwingMongo },
    );
    expect(report.confidence).toBeGreaterThanOrEqual(0);
    expect(report.confidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Scenario G: Multiple connectors fail simultaneously
// ---------------------------------------------------------------------------

describe('HOR-108 connector fallback — Scenario G: multiple simultaneous failures', () => {
  const throwingLogs: LogsProvider = {
    ...baseLogsProvider,
    async analyzeErrors() { throw new Error('ES unreachable'); },
  };

  const throwingQueue: QueueRuntimeProvider = {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: false, detail: 'Redis unreachable' }; },
    async analyzeQueues() { throw new Error('Redis ECONNREFUSED'); },
    toEvidence() { return []; },
    async close() {},
  };

  const throwingMongo: StateProvider = {
    id: 'mongodb',
    kind: 'state',
    async health() { return { ok: false, detail: 'Mongo unreachable' }; },
    async analyzeState(): Promise<StateAnalysis> { throw new Error('Mongo ECONNREFUSED'); },
    toEvidence() { return []; },
    async close() {},
  };

  it('investigate() resolves when all runtime connectors fail', async () => {
    await expect(
      investigate(
        { hint: 'zoho' },
        {
          code: fakeCode,
          db: fakeDbWithQueues,
          logs: throwingLogs,
          queue: throwingQueue,
          mongo: throwingMongo,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('report has no runtime evidence when all connectors fail', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const runtimeKinds = new Set(['log', 'metric', 'queue-state', 'state', 'redis-key']);
    const runtimeEv = report.evidence.filter((e) => runtimeKinds.has(e.kind));
    expect(runtimeEv).toHaveLength(0);
  });

  it('logs gap is present when all connectors fail', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const logsGap = report.gapAnalysis.gaps.find((g) => g.dimension === 'logs');
    expect(logsGap).toBeDefined();
  });

  it('report confidence ceiling is below 1.0 when all connectors fail (multiple gaps)', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    expect(report.gapAnalysis.confidenceCeiling).toBeLessThan(1.0);
  });

  it('error connection strings do not appear in the report', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        logs: throwingLogs,
        queue: throwingQueue,
        mongo: throwingMongo,
      },
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('ECONNREFUSED');
  });
});
