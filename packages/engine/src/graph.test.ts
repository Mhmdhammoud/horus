/**
 * HOR-14 — Unit tests for the investigation graph builder and implication scorer.
 *
 * Each describe block covers one evidence source or one graph contract,
 * mirroring the pattern of normalize.test.ts.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import { buildGraph, maxImplicationScore } from './graph.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEv(
  overrides: Partial<Evidence> & Pick<Evidence, 'id' | 'source' | 'kind' | 'relevance'>,
): Evidence {
  return {
    title: 'test evidence',
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BullMQ queue-edge evidence
// ---------------------------------------------------------------------------

describe('buildGraph — queue-edge evidence', () => {
  it('creates queue, service, and worker nodes', () => {
    const ev = makeEv({
      id: 'ev-edge-1',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'payments', producerSymbol: 'OrderService', workerSymbol: 'PaymentWorker' },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([ev]);

    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('queue:payments');
    expect(ids).toContain('service:OrderService');
    expect(ids).toContain('worker:PaymentWorker');
  });

  it('queue node has type "queue" and correct label', () => {
    const ev = makeEv({
      id: 'ev-edge-2',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'orders', producerSymbol: 'OrderService', workerSymbol: null },
      links: { queueName: 'orders' },
    });
    const g = buildGraph([ev]);
    const queue = g.nodes.find((n) => n.id === 'queue:orders');
    expect(queue?.type).toBe('queue');
    expect(queue?.label).toBe('orders');
  });

  it('creates emits edge from service to queue', () => {
    const ev = makeEv({
      id: 'ev-edge-3',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'payments', producerSymbol: 'OrderService', workerSymbol: 'PaymentWorker' },
      links: {},
    });
    const g = buildGraph([ev]);
    const emits = g.edges.find((e) => e.type === 'emits');
    expect(emits?.from).toBe('service:OrderService');
    expect(emits?.to).toBe('queue:payments');
  });

  it('creates consumes edge from queue to worker', () => {
    const ev = makeEv({
      id: 'ev-edge-4',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'payments', producerSymbol: 'OrderService', workerSymbol: 'PaymentWorker' },
      links: {},
    });
    const g = buildGraph([ev]);
    const consumes = g.edges.find((e) => e.type === 'consumes');
    expect(consumes?.from).toBe('queue:payments');
    expect(consumes?.to).toBe('worker:PaymentWorker');
  });

  it('creates an observed_in edge from the evidence node to the queue', () => {
    const ev = makeEv({
      id: 'ev-edge-5',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'payments', producerSymbol: 'OrderService', workerSymbol: 'PaymentWorker' },
      links: {},
    });
    const g = buildGraph([ev]);
    const obs = g.edges.find((e) => e.type === 'observed_in');
    expect(obs?.from).toBe('ev:ev-edge-5');
    expect(obs?.to).toBe('queue:payments');
  });

  it('skips producer node when producerSymbol is absent', () => {
    const ev = makeEv({
      id: 'ev-edge-6',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'notifications' },
      links: { queueName: 'notifications' },
    });
    const g = buildGraph([ev]);
    const serviceNodes = g.nodes.filter((n) => n.type === 'service');
    expect(serviceNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// BullMQ queue-state evidence
// ---------------------------------------------------------------------------

describe('buildGraph — queue-state evidence', () => {
  it('creates a queue node from queue-state evidence', () => {
    const ev = makeEv({
      id: 'ev-qs-1',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.88,
      payload: { queueName: 'payments', waiting: 4382, active: 1, failed: 0, delayed: 0, completed: 200, isPaused: false },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([ev]);
    const queue = g.nodes.find((n) => n.id === 'queue:payments');
    expect(queue?.type).toBe('queue');
  });

  it('high-relevance queue-state marks the queue as implicated', () => {
    const ev = makeEv({
      id: 'ev-qs-2',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.88,
      payload: { queueName: 'payments', waiting: 4382, active: 0, failed: 0, delayed: 0, completed: 0, isPaused: false },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([ev]);
    const queue = g.nodes.find((n) => n.id === 'queue:payments');
    expect(queue?.implicated).toBe(true);
    expect(queue?.implicationScore).toBeCloseTo(0.88);
  });

  it('low-relevance queue-state does not mark queue as implicated', () => {
    const ev = makeEv({
      id: 'ev-qs-3',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.4,
      payload: { queueName: 'payments', waiting: 5, active: 3, failed: 0, delayed: 0, completed: 500, isPaused: false },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([ev]);
    const queue = g.nodes.find((n) => n.id === 'queue:payments');
    expect(queue?.implicated).toBe(false);
    expect(queue?.implicationScore).toBeCloseTo(0.4);
  });

  it('two queue-state items for the same queue produce one queue node', () => {
    const ev1 = makeEv({ id: 'ev-qs-4a', source: 'queue', kind: 'queue-state', relevance: 0.88, payload: { queueName: 'sync' }, links: { queueName: 'sync' } });
    const ev2 = makeEv({ id: 'ev-qs-4b', source: 'queue', kind: 'queue-state', relevance: 0.5, payload: { queueName: 'sync' }, links: { queueName: 'sync' } });
    const g = buildGraph([ev1, ev2]);
    const queueNodes = g.nodes.filter((n) => n.id === 'queue:sync');
    expect(queueNodes).toHaveLength(1);
    expect(queueNodes[0]!.evidenceIds).toEqual(['ev-qs-4a', 'ev-qs-4b']);
    // implicationScore = max relevance of the two queue-state items
    expect(queueNodes[0]!.implicationScore).toBeCloseTo(0.88);
  });
});

// ---------------------------------------------------------------------------
// Log (Elasticsearch) evidence
// ---------------------------------------------------------------------------

describe('buildGraph — log evidence', () => {
  it('creates service nodes from payload.services', () => {
    const ev = makeEv({
      id: 'ev-log-1',
      source: 'logs',
      kind: 'log',
      relevance: 0.9,
      payload: { signature: 'AUTH_FAIL', count: 42, services: ['api', 'gateway'], isNew: true },
      links: {},
    });
    const g = buildGraph([ev]);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('service:api');
    expect(ids).toContain('service:gateway');
    const api = g.nodes.find((n) => n.id === 'service:api');
    expect(api?.type).toBe('service');
  });

  it('high-relevance log marks service as implicated', () => {
    const ev = makeEv({
      id: 'ev-log-2',
      source: 'logs',
      kind: 'log',
      relevance: 0.95,
      payload: { signature: 'DB_TIMEOUT', count: 120, services: ['api'], isNew: false },
      links: {},
    });
    const g = buildGraph([ev]);
    const service = g.nodes.find((n) => n.id === 'service:api');
    expect(service?.implicated).toBe(true);
    expect(service?.implicationScore).toBeCloseTo(0.95);
  });

  it('creates observed_in edges from evidence node to each service', () => {
    const ev = makeEv({
      id: 'ev-log-3',
      source: 'logs',
      kind: 'log',
      relevance: 0.8,
      payload: { services: ['api', 'worker'] },
      links: {},
    });
    const g = buildGraph([ev]);
    const obsEdges = g.edges.filter((e) => e.type === 'observed_in');
    const tos = obsEdges.map((e) => e.to);
    expect(tos).toContain('service:api');
    expect(tos).toContain('service:worker');
  });

  it('no service nodes when services array is empty', () => {
    const ev = makeEv({
      id: 'ev-log-4',
      source: 'logs',
      kind: 'log',
      relevance: 0.7,
      payload: { signature: 'UNKNOWN', count: 5, services: [] },
      links: {},
    });
    const g = buildGraph([ev]);
    const serviceNodes = g.nodes.filter((n) => n.type === 'service');
    expect(serviceNodes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MongoDB state evidence
// ---------------------------------------------------------------------------

describe('buildGraph — MongoDB state evidence', () => {
  it('creates a collection node from payload.collection', () => {
    const ev = makeEv({
      id: 'ev-state-1',
      source: 'state',
      kind: 'state',
      relevance: 0.85,
      payload: { collection: 'orders', status: 'failed', count: 12 },
      links: {},
    });
    const g = buildGraph([ev]);
    const coll = g.nodes.find((n) => n.id === 'collection:orders');
    expect(coll?.type).toBe('collection');
    expect(coll?.label).toBe('orders');
  });

  it('high-relevance state marks collection as implicated', () => {
    const ev = makeEv({
      id: 'ev-state-2',
      source: 'state',
      kind: 'state',
      relevance: 0.85,
      payload: { collection: 'orders', status: 'failed', count: 12 },
      links: {},
    });
    const g = buildGraph([ev]);
    const coll = g.nodes.find((n) => n.id === 'collection:orders');
    expect(coll?.implicated).toBe(true);
  });

  it('low-relevance state does not implicate the collection', () => {
    const ev = makeEv({
      id: 'ev-state-3',
      source: 'state',
      kind: 'state',
      relevance: 0.3,
      payload: { collection: 'sessions', count: 1000 },
      links: {},
    });
    const g = buildGraph([ev]);
    const coll = g.nodes.find((n) => n.id === 'collection:sessions');
    expect(coll?.implicated).toBe(false);
  });

  it('creates observed_in edge from evidence node to collection', () => {
    const ev = makeEv({
      id: 'ev-state-4',
      source: 'state',
      kind: 'state',
      relevance: 0.7,
      payload: { collection: 'jobs' },
      links: {},
    });
    const g = buildGraph([ev]);
    const obs = g.edges.find((e) => e.type === 'observed_in' && e.to === 'collection:jobs');
    expect(obs?.from).toBe('ev:ev-state-4');
  });
});

// ---------------------------------------------------------------------------
// Mixed evidence graph
// ---------------------------------------------------------------------------

describe('buildGraph — mixed evidence', () => {
  it('merges queue-edge and queue-state into one queue node', () => {
    const edgeEv = makeEv({
      id: 'ev-mixed-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'payments', producerSymbol: 'OrderService', workerSymbol: 'PaymentWorker' },
      links: {},
    });
    const stateEv = makeEv({
      id: 'ev-mixed-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.88,
      payload: { queueName: 'payments', waiting: 500 },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([edgeEv, stateEv]);

    const queueNodes = g.nodes.filter((n) => n.id === 'queue:payments');
    expect(queueNodes).toHaveLength(1);
    // Both evidence items are attached to the single queue node
    expect(queueNodes[0]!.evidenceIds).toEqual(['ev-mixed-edge', 'ev-mixed-state']);
    // implicationScore = 0.88 from queue-state; queue-edge is structural (excluded)
    expect(queueNodes[0]!.implicationScore).toBeCloseTo(0.88);
  });

  it('builds a complete service→queue→worker topology', () => {
    const edge = makeEv({
      id: 'ev-topo-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'invoices', producerSymbol: 'InvoiceService', workerSymbol: 'InvoiceWorker' },
      links: {},
    });
    const state = makeEv({
      id: 'ev-topo-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.9,
      payload: { queueName: 'invoices', waiting: 1500 },
      links: { queueName: 'invoices' },
    });
    const log = makeEv({
      id: 'ev-topo-log',
      source: 'logs',
      kind: 'log',
      relevance: 0.8,
      payload: { services: ['api'] },
      links: {},
    });
    const g = buildGraph([edge, state, log]);

    const nodeIds = g.nodes.map((n) => n.id);
    expect(nodeIds).toContain('queue:invoices');
    expect(nodeIds).toContain('service:InvoiceService');
    expect(nodeIds).toContain('worker:InvoiceWorker');
    expect(nodeIds).toContain('service:api');

    const edgeTypes = g.edges.map((e) => e.type);
    expect(edgeTypes).toContain('emits');
    expect(edgeTypes).toContain('consumes');
    expect(edgeTypes).toContain('observed_in');
  });
});

// ---------------------------------------------------------------------------
// Deterministic output
// ---------------------------------------------------------------------------

describe('buildGraph — deterministic output', () => {
  it('produces identical graphs for the same evidence regardless of input order', () => {
    const ev1 = makeEv({ id: 'ev-det-1', source: 'queue', kind: 'queue-state', relevance: 0.7, payload: { queueName: 'alpha' }, links: { queueName: 'alpha' } });
    const ev2 = makeEv({ id: 'ev-det-2', source: 'logs', kind: 'log', relevance: 0.8, payload: { services: ['svc-a'] }, links: {} });
    const ev3 = makeEv({ id: 'ev-det-3', source: 'state', kind: 'state', relevance: 0.6, payload: { collection: 'users' }, links: {} });

    const g1 = buildGraph([ev1, ev2, ev3]);
    const g2 = buildGraph([ev3, ev1, ev2]);
    const g3 = buildGraph([ev2, ev3, ev1]);

    expect(JSON.stringify(g1)).toBe(JSON.stringify(g2));
    expect(JSON.stringify(g1)).toBe(JSON.stringify(g3));
  });

  it('node ids are stable content-derived strings', () => {
    const ev = makeEv({
      id: 'ev-stable',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.7,
      payload: { queueName: 'stable-queue' },
      links: { queueName: 'stable-queue' },
    });
    const g = buildGraph([ev]);
    const queueNode = g.nodes.find((n) => n.id === 'queue:stable-queue');
    expect(queueNode).toBeDefined();
  });

  it('edge ids follow the {from}--{type}-->{to} pattern', () => {
    const ev = makeEv({
      id: 'ev-eid',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.75,
      payload: { queueName: 'q', producerSymbol: 'P', workerSymbol: 'W' },
      links: {},
    });
    const g = buildGraph([ev]);
    const emits = g.edges.find((e) => e.type === 'emits');
    expect(emits?.id).toBe('service:P--emits-->queue:q');
    const consumes = g.edges.find((e) => e.type === 'consumes');
    expect(consumes?.id).toBe('queue:q--consumes-->worker:W');
  });
});

// ---------------------------------------------------------------------------
// Implication propagation
// ---------------------------------------------------------------------------

describe('buildGraph — implication propagation', () => {
  it('high-relevance queue-state propagates score to connected service and worker', () => {
    // queue-edge is structural evidence — excluded from implication scoring, so
    // service and worker start with base score 0 and receive only propagated score
    const edge = makeEv({
      id: 'ev-prop-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.9,
      payload: { queueName: 'jobs', producerSymbol: 'Producer', workerSymbol: 'Consumer' },
      links: {},
    });
    // queue-state is runtime evidence — contributes to implication scoring
    const state = makeEv({
      id: 'ev-prop-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.9,
      payload: { queueName: 'jobs', waiting: 2000 },
      links: { queueName: 'jobs' },
    });
    const g = buildGraph([edge, state]);

    const queue = g.nodes.find((n) => n.id === 'queue:jobs')!;
    const service = g.nodes.find((n) => n.id === 'service:Producer')!;
    const worker = g.nodes.find((n) => n.id === 'worker:Consumer')!;

    // Queue: structural queue-edge excluded; queue-state (0.9) is included
    expect(queue.implicationScore).toBeCloseTo(0.9);
    expect(queue.implicated).toBe(true);

    // Service and worker: structural evidence excluded → base score 0.
    // Queue propagates 0.9 × 0.7 = 0.63 in one hop.
    expect(service.implicationScore).toBeCloseTo(0.63);
    expect(service.implicated).toBe(true);
    expect(worker.implicationScore).toBeCloseTo(0.63);
    expect(worker.implicated).toBe(true);
  });

  it('structural queue-edge evidence alone does not implicate any node', () => {
    const edge = makeEv({
      id: 'ev-struct-only',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.9, // high relevance but structural kind — excluded from scoring
      payload: { queueName: 'topology', producerSymbol: 'Prod', workerSymbol: 'Work' },
      links: {},
    });
    const g = buildGraph([edge]);
    const queue = g.nodes.find((n) => n.id === 'queue:topology')!;
    const service = g.nodes.find((n) => n.id === 'service:Prod')!;
    const worker = g.nodes.find((n) => n.id === 'worker:Work')!;
    expect(queue.implicated).toBe(false);
    expect(queue.implicationScore).toBe(0);
    expect(service.implicated).toBe(false);
    expect(worker.implicated).toBe(false);
  });

  it('service anomaly propagates to its queue but not through the queue to its worker', () => {
    // The single-hop guarantee: service → queue (one hop) is implicated,
    // but queue → worker (second hop) must not receive score in the same pass.
    const log = makeEv({
      id: 'ev-svc-anomaly',
      source: 'logs',
      kind: 'log',
      relevance: 0.9,
      payload: { services: ['api'] },
      links: {},
    });
    const edge = makeEv({
      id: 'ev-q-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.9,
      payload: { queueName: 'orders', producerSymbol: 'api', workerSymbol: 'OrderWorker' },
      links: {},
    });
    const g = buildGraph([log, edge]);

    const service = g.nodes.find((n) => n.id === 'service:api')!;
    const queue = g.nodes.find((n) => n.id === 'queue:orders')!;
    const worker = g.nodes.find((n) => n.id === 'worker:OrderWorker')!;

    // Service: direct log evidence (runtime, not excluded) → base score 0.9
    expect(service.implicationScore).toBeCloseTo(0.9);
    expect(service.implicated).toBe(true);

    // Queue: no runtime evidence directly; receives one-hop propagation from service
    expect(queue.implicationScore).toBeCloseTo(0.63); // 0.9 × 0.7
    expect(queue.implicated).toBe(true);

    // Worker: would require a second hop (service→queue→worker). Queue base score
    // was 0 at propagation read time, so worker receives nothing.
    expect(worker.implicationScore).toBe(0);
    expect(worker.implicated).toBe(false);
  });

  it('low-relevance runtime evidence produces no implication propagation', () => {
    const edge = makeEv({
      id: 'ev-noprop-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.9,
      payload: { queueName: 'idle', producerSymbol: 'Idle', workerSymbol: 'Worker' },
      links: {},
    });
    const state = makeEv({
      id: 'ev-noprop-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.3, // healthy snapshot — below implication threshold
      payload: { queueName: 'idle' },
      links: { queueName: 'idle' },
    });
    const g = buildGraph([edge, state]);

    // queue-state is runtime evidence: queue.implicationScore = 0.3, not implicated
    const queue = g.nodes.find((n) => n.id === 'queue:idle')!;
    expect(queue.implicated).toBe(false);
    expect(queue.implicationScore).toBeCloseTo(0.3);

    // Propagated 0.3 × 0.7 = 0.21 — below the 0.6 threshold
    const service = g.nodes.find((n) => n.id === 'service:Idle')!;
    expect(service.implicated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// maxImplicationScore
// ---------------------------------------------------------------------------

describe('maxImplicationScore', () => {
  it('returns the implication score of the implicated infrastructure node linked to the given evidence', () => {
    const edge = makeEv({
      id: 'ev-mis-edge',
      source: 'queue',
      kind: 'queue-edge',
      relevance: 0.9,
      payload: { queueName: 'payments', producerSymbol: 'S', workerSymbol: 'W' },
      links: {},
    });
    const state = makeEv({
      id: 'ev-mis-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.88,
      payload: { queueName: 'payments' },
      links: { queueName: 'payments' },
    });
    const g = buildGraph([edge, state]);

    // queue node has both evidence IDs attached.
    // queue.implicationScore = 0.88 (from queue-state; queue-edge is structural, excluded).
    // queue.implicated = true (0.88 >= 0.6).
    const score = maxImplicationScore(g, ['ev-mis-edge']);
    expect(score).toBeCloseTo(0.88);
  });

  it('returns 0 when the matching infrastructure node is not implicated', () => {
    // queue-state with low relevance — creates the node but does not implicate it
    const state = makeEv({
      id: 'ev-healthy-state',
      source: 'queue',
      kind: 'queue-state',
      relevance: 0.4, // below the 0.6 implication threshold
      payload: { queueName: 'healthy' },
      links: { queueName: 'healthy' },
    });
    const g = buildGraph([state]);
    // queue:healthy exists and has the evidence ID, but is not implicated
    const queue = g.nodes.find((n) => n.id === 'queue:healthy')!;
    expect(queue.implicated).toBe(false);
    expect(maxImplicationScore(g, ['ev-healthy-state'])).toBe(0);
  });

  it('returns 0 when evidence ids match only evidence nodes (not infrastructure)', () => {
    // symbol evidence creates no infrastructure node
    const ev = makeEv({
      id: 'ev-symbol',
      source: 'code',
      kind: 'symbol',
      relevance: 0.9,
      payload: { symbol: { id: 'sym:foo', name: 'foo' } },
      links: { symbolId: 'sym:foo' },
    });
    const g = buildGraph([ev]);
    const score = maxImplicationScore(g, ['ev-symbol']);
    expect(score).toBe(0);
  });

  it('returns 0 for empty evidence list', () => {
    const ev = makeEv({ id: 'ev-x', source: 'logs', kind: 'log', relevance: 0.9, payload: { services: ['api'] }, links: {} });
    const g = buildGraph([ev]);
    expect(maxImplicationScore(g, [])).toBe(0);
  });

  it('returns the highest score when evidence touches multiple infrastructure nodes', () => {
    const log1 = makeEv({ id: 'ev-multi-1', source: 'logs', kind: 'log', relevance: 0.7, payload: { services: ['svc-a'] }, links: {} });
    const log2 = makeEv({ id: 'ev-multi-2', source: 'logs', kind: 'log', relevance: 0.95, payload: { services: ['svc-b'] }, links: {} });
    const g = buildGraph([log1, log2]);
    // ask for both — should return max(0.7, 0.95)
    const score = maxImplicationScore(g, ['ev-multi-1', 'ev-multi-2']);
    expect(score).toBeCloseTo(0.95);
  });
});
