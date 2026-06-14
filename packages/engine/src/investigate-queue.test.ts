/**
 * HOR-45 — Integration tests: investigate() with BullMQ queue runtime evidence.
 *
 * Verifies the five required paths through the queue hypothesis pipeline:
 * 1. Structural queue-edge only → queue-backlog and worker-slowdown are 'unconfirmed'
 * 2. BullMQ backlog snapshot → queue-backlog is 'supported'
 * 3. BullMQ starvation snapshot → worker-slowdown is 'supported' (hedged)
 * 4. Healthy queue snapshot → no anomaly hypothesis is 'supported'
 * 5. Grafana queue-growth metric matched to queue name → worker-slowdown is 'supported'
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { QueueRuntimeProvider, QueueRuntimeState, MetricFinding } from '@horus/connectors';
import type { MetricsProvider } from '@horus/connectors';
import type { HorusDb, QueueEdge } from '@horus/db';
import type { Evidence } from '@horus/core';
import { investigate } from './engine.js';

// ---------------------------------------------------------------------------
// Shared fake providers (same shape as investigate-logs.test.ts)
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
    return {
      symbol: FAKE_SYMBOL,
      callers: [],
      callees: [],
      imports: [],
      usesType: [],
      community: null,
      coupledWith: [],
    };
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
// DB stubs — one without queue edges (baseline) and one with
// ---------------------------------------------------------------------------

function makeDb(queueEdgeRows: QueueEdge[] = []): HorusDb {
  return {
    select() {
      return {
        from(_table: unknown) {
          return Promise.resolve(queueEdgeRows);
        },
      };
    },
    insert(_table: unknown) {
      return {
        values(_rows: unknown) {
          return {
            returning(_cols: unknown): Promise<{ id: string }[]> {
              return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
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

const FAKE_QUEUE_EDGE: QueueEdge = {
  id: globalThis.crypto.randomUUID(),
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

const fakeDb = makeDb([]);
const fakeDbWithQueues = makeDb([FAKE_QUEUE_EDGE]);

// ---------------------------------------------------------------------------
// Queue runtime provider factory
// ---------------------------------------------------------------------------

function makeQueueProvider(state: QueueRuntimeState): QueueRuntimeProvider {
  return {
    id: 'bullmq',
    kind: 'queue',
    async health() { return { ok: true, detail: 'fake' }; },
    async analyzeQueues() { return state; },
    toEvidence() { return []; },
    async close() {},
  };
}

function makeQueueState(waiting: number, active: number, failed = 0): QueueRuntimeState {
  return {
    prefix: 'bull',
    collectedAt: new Date().toISOString(),
    queues: [{
      queueName: 'orders',
      waiting,
      active,
      failed,
      delayed: 0,
      completed: 100,
      paused: 0,
      isPaused: false,
    }],
  };
}

// ---------------------------------------------------------------------------
// 1. Structural queue-edge only → both queue hypotheses are 'unconfirmed'
// ---------------------------------------------------------------------------

describe('investigate() — structural queue-edge only', () => {
  it('queue-backlog and worker-slowdown are unconfirmed without runtime evidence', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues },
    );

    const qb = report.hypotheses.find((h) => h.category === 'queue-backlog');
    const ws = report.hypotheses.find((h) => h.category === 'worker-slowdown');
    expect(qb).toBeDefined();
    expect(ws).toBeDefined();
    expect(qb?.verdict).toBe('unconfirmed');
    expect(ws?.verdict).toBe('unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// 2. BullMQ backlog snapshot → queue-backlog is 'supported'
//    waiting=5000, active=10: exceeds BACKLOG_HIGH (1000), active > 0 so NOT starvation
// ---------------------------------------------------------------------------

describe('investigate() — BullMQ backlog snapshot', () => {
  it('queue-backlog is supported when backlog signal is present', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        queue: makeQueueProvider(makeQueueState(5000, 10)),
      },
    );

    const qb = report.hypotheses.find((h) => h.category === 'queue-backlog');
    expect(qb).toBeDefined();
    expect(qb?.verdict).toBe('supported');
    // worker-slowdown has no metric or starvation evidence — stays unconfirmed
    const ws = report.hypotheses.find((h) => h.category === 'worker-slowdown');
    expect(ws?.verdict).toBe('unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// 3. BullMQ starvation → worker-slowdown is 'supported' (hedged single snapshot)
//    waiting=50, active=0: triggers worker-starvation signal (STARVATION_MIN=10)
// ---------------------------------------------------------------------------

describe('investigate() — BullMQ starvation snapshot', () => {
  it('worker-slowdown is supported when starvation signal is present', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        queue: makeQueueProvider(makeQueueState(50, 0)),
      },
    );

    const ws = report.hypotheses.find((h) => h.category === 'worker-slowdown');
    expect(ws).toBeDefined();
    expect(ws?.verdict).toBe('supported');
    // starvation is a hedged single-snapshot signal — confidence stays below 0.8
    expect(ws?.confidence).toBeLessThan(0.8);
    // queue-backlog stays unconfirmed: starvation with waiting=50 is below BACKLOG_WARN(100)
    const qb = report.hypotheses.find((h) => h.category === 'queue-backlog');
    expect(qb?.verdict).toBe('unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// 4. Healthy queue → no anomaly hypothesis is 'supported'
//    waiting=5, active=3: below all thresholds, no signals emitted
// ---------------------------------------------------------------------------

describe('investigate() — healthy queue snapshot', () => {
  it('no queue hypothesis is supported when the queue is healthy', async () => {
    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        queue: makeQueueProvider(makeQueueState(5, 3)),
      },
    );

    const qb = report.hypotheses.find((h) => h.category === 'queue-backlog');
    const ws = report.hypotheses.find((h) => h.category === 'worker-slowdown');
    expect(qb?.verdict).toBe('unconfirmed');
    expect(ws?.verdict).toBe('unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// 5. Grafana queue-growth matched to queue name → worker-slowdown is 'supported'
// ---------------------------------------------------------------------------

describe('investigate() — Grafana queue-growth metric matched to queue', () => {
  it('worker-slowdown is supported when a matched queue-growth anomaly is present', async () => {
    const queueGrowthFinding: MetricFinding = {
      dashboardUid: 'dash-1',
      panelTitle: 'orders queue depth',  // contains 'orders' — matches the queue name
      kind: 'queue',
      anomaly: 'queue-growth',
      labels: {},
      baselineAvg: 100,
      currentAvg: 5000,
      ratio: 50,
      lastValue: 5000,
    };

    const fakeMetrics: MetricsProvider = {
      id: 'grafana',
      kind: 'metrics',
      async health() { return { ok: true, detail: 'fake' }; },
      async findPanels() { return []; },
      async analyze() { return [queueGrowthFinding]; },
      async rawRange() { return []; },
      toEvidence(findings: MetricFinding[]): Evidence[] {
        return findings.map((f, i) => ({
          id: `ev_metric_${i}`,
          source: 'metrics' as const,
          kind: 'metric' as const,
          title: `${f.panelTitle}: queue-growth anomaly (ratio ${f.ratio.toFixed(1)}×)`,
          relevance: 0.8,
          payload: { anomaly: f.anomaly, ratio: f.ratio },
          links: {},
          provenance: { query: 'zoho', collectedAt: new Date().toISOString() },
        }));
      },
    };

    const report = await investigate(
      { hint: 'zoho' },
      {
        code: fakeCode,
        db: fakeDbWithQueues,
        metrics: fakeMetrics,
        connectors: { grafana: true },
      },
    );

    const ws = report.hypotheses.find((h) => h.category === 'worker-slowdown');
    expect(ws).toBeDefined();
    expect(ws?.verdict).toBe('supported');
  });
});

// ---------------------------------------------------------------------------
// 6. Multi-queue: backlog on 'orders' must not contaminate 'email' hypothesis
// ---------------------------------------------------------------------------

describe('investigate() — multi-queue attribution', () => {
  it('backlog on orders does not produce a supported queue-backlog hypothesis for email', async () => {
    const ordersEdge: QueueEdge = {
      id: globalThis.crypto.randomUUID(),
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
    const emailEdge: QueueEdge = {
      id: globalThis.crypto.randomUUID(),
      queueName: 'email',
      producerSymbol: 'ZohoSyncWorker',
      producerFile: 'src/workers/zoho-sync.worker.ts',
      workerSymbol: 'EmailWorker',
      workerFile: 'src/workers/email.worker.ts',
      source: 'stitcher',
      project: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const dbWithTwoQueues = makeDb([ordersEdge, emailEdge]);

    // BullMQ: 'orders' has severe backlog, 'email' is healthy
    const twoQueueState: QueueRuntimeState = {
      prefix: 'bull',
      collectedAt: new Date().toISOString(),
      queues: [
        { queueName: 'orders', waiting: 5000, active: 10, failed: 0, delayed: 0, completed: 100, paused: 0, isPaused: false },
        { queueName: 'email', waiting: 2, active: 5, failed: 0, delayed: 0, completed: 500, paused: 0, isPaused: false },
      ],
    };

    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: dbWithTwoQueues, queue: makeQueueProvider(twoQueueState) },
    );

    const qbOrders = report.hypotheses.find(
      (h) => h.category === 'queue-backlog' && h.statement.includes('orders'),
    );
    const qbEmail = report.hypotheses.find(
      (h) => h.category === 'queue-backlog' && h.statement.includes('email'),
    );

    // orders: backlog signal present → supported
    expect(qbOrders?.verdict).toBe('supported');
    // email: no backlog signal → unconfirmed (evidence from orders must not spill over)
    expect(qbEmail?.verdict).toBe('unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// 7. Confidence: single provider with many derived records cannot saturate
// ---------------------------------------------------------------------------

describe('investigate() — confidence source cap', () => {
  it('a verbose BullMQ snapshot does not produce confidence > 0.9 from evidence alone', async () => {
    // Snapshot designed to emit as many signals as possible:
    // starvation + oldest-job + failed-spike + failed-breakdown + summary
    const verboseState: QueueRuntimeState = {
      prefix: 'bull',
      collectedAt: new Date().toISOString(),
      queues: [{
        queueName: 'orders',
        waiting: 50,
        active: 0,           // starvation
        failed: 150,         // severe failed-spike
        delayed: 0,
        completed: 100,
        paused: 0,
        isPaused: false,
        oldestWaitingMs: 90 * 60_000,  // oldest-job > 1h (severe)
        failedBreakdown: [{ reason: 'TimeoutError', count: 15 }, { reason: 'NetworkError', count: 5 }],
      }],
    };

    const report = await investigate(
      { hint: 'zoho' },
      { code: fakeCode, db: fakeDbWithQueues, queue: makeQueueProvider(verboseState) },
    );

    // report.confidence is the final value after gap ceiling — must be < 0.9
    // so one provider snapshot cannot push confidence near 1.0 on its own.
    expect(report.confidence).toBeLessThan(0.9);
  });
});
