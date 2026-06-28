/**
 * HOR-14 — pure unit tests for the deterministic correlate() function.
 * No I/O, no external deps; all evidence is synthesised inline.
 */

import { describe, it, expect } from 'vitest';
import { correlate } from './correlate.js';
import type { Evidence } from '@horus/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvidence(): Evidence[] {
  const base = {
    source: 'code' as const,
    relevance: 0.8,
    payload: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };

  const symbolEv: Evidence = {
    ...base,
    id: 'ev-symbol-001',
    source: 'code',
    kind: 'symbol',
    title: 'Seed symbol OrderService (src/order.ts:10)',
    relevance: 0.9,
    links: { symbolId: 's1', file: 'a.ts', line: 10 },
    provenance: { query: 'OrderService', collectedAt: '2026-06-14T00:00:00Z' },
  };

  const queueEdgeEv: Evidence = {
    ...base,
    id: 'ev-queue-001',
    source: 'queue',
    kind: 'queue-edge',
    title: 'Queue "orders": OrderService -> OrderProcessor',
    relevance: 0.75,
    links: { queueName: 'orders' },
    payload: {
      queueName: 'orders',
      producerSymbol: 'OrderService',
      producerFile: 'src/order.ts',
      workerSymbol: 'OrderProcessor',
      workerFile: 'src/processor.ts',
      source: 'static',
    },
    provenance: { query: 'OrderService', collectedAt: '2026-06-14T00:00:00Z' },
  };

  const impactEv: Evidence = {
    ...base,
    id: 'ev-impact-001',
    source: 'code',
    kind: 'impact',
    title: 'Impact of OrderService: 3 affected symbol(s)',
    relevance: 0.7,
    links: { symbolId: 's1', file: 'a.ts' },
    payload: { affected: 3 },
    provenance: { query: 'OrderService', collectedAt: '2026-06-14T00:00:00Z' },
  };

  const commitEv: Evidence = {
    ...base,
    id: 'ev-commit-001',
    source: 'history',
    kind: 'commit',
    title: 'Change range v1.0.0..HEAD: +2 -0 ~1 symbol(s)',
    relevance: 0.65,
    links: {},
    payload: { added: 2, removed: 0, modified: 1 },
    provenance: { query: 'OrderService', collectedAt: '2026-06-14T00:00:00Z' },
  };

  return [symbolEv, queueEdgeEv, impactEv, commitEv];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('correlate()', () => {
  it('returns groups, chains, and missing for a representative evidence set', () => {
    const evidence = makeEvidence();
    const result = correlate(evidence);

    expect(result).toHaveProperty('groups');
    expect(result).toHaveProperty('chains');
    expect(result).toHaveProperty('missing');
  });

  describe('groups', () => {
    it('emits at least one group for the shared symbolId s1 (symbol + impact both link it)', () => {
      const evidence = makeEvidence();
      const { groups } = correlate(evidence);

      const symbolGroup = groups.find((g) => g.dimension === 'symbol' && g.key === 's1');
      expect(symbolGroup).toBeDefined();
      expect(symbolGroup!.evidenceIds.length).toBeGreaterThanOrEqual(2);
      expect(symbolGroup!.evidenceIds).toContain('ev-symbol-001');
      expect(symbolGroup!.evidenceIds).toContain('ev-impact-001');
    });

    it('emits at least one group for the shared file a.ts (symbol + impact both link it)', () => {
      const evidence = makeEvidence();
      const { groups } = correlate(evidence);

      const fileGroup = groups.find((g) => g.dimension === 'file' && g.key === 'a.ts');
      expect(fileGroup).toBeDefined();
      expect(fileGroup!.evidenceIds.length).toBeGreaterThanOrEqual(2);
    });

    it('sorts groups by evidenceIds.length descending', () => {
      const evidence = makeEvidence();
      const { groups } = correlate(evidence);

      for (let i = 0; i < groups.length - 1; i++) {
        const a = groups[i];
        const b = groups[i + 1];
        // noUncheckedIndexedAccess guard
        if (a === undefined || b === undefined) continue;
        expect(a.evidenceIds.length).toBeGreaterThanOrEqual(b.evidenceIds.length);
      }
    });
  });

  describe('chains', () => {
    it('emits at least one cause chain whose title mentions "orders"', () => {
      const evidence = makeEvidence();
      const { chains } = correlate(evidence);

      const ordersChain = chains.find((c) => c.title.includes('orders'));
      expect(ordersChain).toBeDefined();
    });

    it('chain strength is a number in [0, 1]', () => {
      const evidence = makeEvidence();
      const { chains } = correlate(evidence);

      for (const chain of chains) {
        expect(chain.strength).toBeGreaterThanOrEqual(0);
        expect(chain.strength).toBeLessThanOrEqual(1);
      }
    });

    it('chains are sorted by strength descending', () => {
      const evidence = makeEvidence();
      const { chains } = correlate(evidence);

      for (let i = 0; i < chains.length - 1; i++) {
        const a = chains[i];
        const b = chains[i + 1];
        if (a === undefined || b === undefined) continue;
        expect(a.strength).toBeGreaterThanOrEqual(b.strength);
      }
    });

    it('the orders chain rationale mentions a recent change (commit is present)', () => {
      const evidence = makeEvidence();
      const { chains } = correlate(evidence);

      const ordersChain = chains.find((c) => c.title.includes('orders'));
      expect(ordersChain).toBeDefined();
      expect(ordersChain!.rationale.toLowerCase()).toMatch(/recent change/);
    });

    it('emits a fallback "Recent change" chain when there are no queue-edge items but commit + symbol exist', () => {
      const evidence = makeEvidence().filter((e) => e.kind !== 'queue-edge');
      const { chains } = correlate(evidence);

      expect(chains.length).toBeGreaterThanOrEqual(1);
      const fallback = chains.find((c) => c.title.includes('Recent change'));
      expect(fallback).toBeDefined();
    });

    it('HOR-406: recentChangeRelevant=false suppresses the fallback "Recent change" chain', () => {
      const evidence = makeEvidence().filter((e) => e.kind !== 'queue-edge');
      const { chains } = correlate(evidence, { recentChangeRelevant: false });

      // No "may have introduced the regression" chain is asserted off an irrelevant change.
      const fallback = chains.find((c) => c.title.includes('Recent change'));
      expect(fallback).toBeUndefined();
      expect(chains.some((c) => /introduced the regression/i.test(c.rationale))).toBe(false);
    });

    it('HOR-406: recentChangeRelevant=false drops the "a recent change is present" clause from the queue chain', () => {
      const evidence = makeEvidence();
      const { chains } = correlate(evidence, { recentChangeRelevant: false });

      const ordersChain = chains.find((c) => c.title.includes('orders'));
      expect(ordersChain).toBeDefined();
      expect(ordersChain!.rationale.toLowerCase()).not.toMatch(/recent change/);
      expect(ordersChain!.rationale).toBe('The implicated symbol sits on this queue boundary');
    });
  });

  describe('missing evidence', () => {
    it('reports missing log evidence', () => {
      const { missing } = correlate(makeEvidence());
      const logEntry = missing.find((m) => m.kind === 'log');
      expect(logEntry).toBeDefined();
      expect(logEntry!.note).toMatch(/log/i);
    });

    it('reports missing metric evidence', () => {
      const { missing } = correlate(makeEvidence());
      const metricEntry = missing.find((m) => m.kind === 'metric');
      expect(metricEntry).toBeDefined();
      expect(metricEntry!.note).toMatch(/metric/i);
    });

    it('reports missing queue-state evidence', () => {
      const { missing } = correlate(makeEvidence());
      const queueStateEntry = missing.find((m) => m.kind === 'queue-state');
      expect(queueStateEntry).toBeDefined();
      expect(queueStateEntry!.note).toMatch(/queue/i);
    });

    it('reports missing cache/state (redis-key) evidence with stack-neutral wording', () => {
      const { missing } = correlate(makeEvidence());
      const redisEntry = missing.find((m) => m.kind === 'redis-key');
      expect(redisEntry).toBeDefined();
      expect(redisEntry!.note).toMatch(/cache|state/i);
      // HOR-410 (round 2): the note must NOT name a specific backend (Redis) — that
      // fabricates a Node-stack datastore on repos that don't have one.
      expect(redisEntry!.note).not.toMatch(/redis/i);
    });

    // HOR-410 (round 2): a repo with NO queue topology must not surface a queue-state
    // missing note, and no missing note may name BullMQ / Redis / Elasticsearch — naming
    // a Node queue/log stack on a Python / Kafka / 0-queue repo is fabricated boilerplate.
    it('(HOR-410) 0-queue repo → no queue-state note and no BullMQ/Redis/Elasticsearch literals', () => {
      const { missing } = correlate(makeEvidence(), { hasQueueTopology: false });
      expect(missing.find((m) => m.kind === 'queue-state')).toBeUndefined();
      const stackRe = /bullmq|redis|elasticsearch/i;
      for (const m of missing) {
        expect(m.note).not.toMatch(stackRe);
      }
    });

    it('contains entries for all four runtime kinds', () => {
      const { missing } = correlate(makeEvidence());
      const kinds = new Set(missing.map((m) => m.kind));
      expect(kinds.has('log')).toBe(true);
      expect(kinds.has('metric')).toBe(true);
      expect(kinds.has('queue-state')).toBe(true);
      expect(kinds.has('redis-key')).toBe(true);
    });

    it('does not report a kind as missing when it is present in evidence', () => {
      // Add a log evidence item
      const logEv: Evidence = {
        id: 'ev-log-001',
        source: 'logs',
        kind: 'log',
        title: 'ERROR timeout in OrderService',
        relevance: 0.8,
        payload: {},
        links: {},
        provenance: { query: 'test', collectedAt: '2026-06-14T00:00:00Z' },
      };
      const { missing } = correlate([...makeEvidence(), logEv]);
      expect(missing.find((m) => m.kind === 'log')).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles empty evidence gracefully', () => {
      const result = correlate([]);
      expect(result.groups).toHaveLength(0);
      expect(result.chains).toHaveLength(0);
      expect(result.missing).toHaveLength(4); // all four runtime kinds missing
    });

    it('emits no groups for evidence with no shared keys', () => {
      const ev1: Evidence = {
        id: 'ev-a',
        source: 'code',
        kind: 'symbol',
        title: 'Symbol A',
        relevance: 0.5,
        payload: {},
        links: { symbolId: 'sym-a', file: 'a.ts' },
        provenance: { query: 'a', collectedAt: '2026-06-14T00:00:00Z' },
      };
      const ev2: Evidence = {
        id: 'ev-b',
        source: 'code',
        kind: 'impact',
        title: 'Impact B',
        relevance: 0.5,
        payload: {},
        links: { symbolId: 'sym-b', file: 'b.ts' },
        provenance: { query: 'b', collectedAt: '2026-06-14T00:00:00Z' },
      };
      const { groups } = correlate([ev1, ev2]);
      expect(groups).toHaveLength(0);
    });
  });
});
