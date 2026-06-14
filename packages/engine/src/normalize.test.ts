/**
 * HOR-13 — Unit tests for the evidence normalization layer.
 *
 * Each describe block mirrors one provider's output shape so it's obvious
 * that the layer handles every source correctly.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import { normalizeEvidence } from './normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEv(overrides: Partial<Evidence> & Pick<Evidence, 'id' | 'source' | 'kind' | 'relevance'>): Evidence {
  return {
    title: 'test evidence',
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Logs (Elasticsearch) — source: 'logs', kind: 'log'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — logs provider', () => {
  it('fatal log (relevance 1.0) → category logs, severity critical', () => {
    const ev = makeEv({ id: 'ev1', source: 'logs', kind: 'log', relevance: 1.0,
      title: '[fatal] auth: unhandled exception' });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('logs');
    expect(ev.severity).toBe('critical');
  });

  it('error log (relevance 0.9) → severity critical', () => {
    const ev = makeEv({ id: 'ev2', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('critical');
  });

  it('warn log (relevance 0.6) → severity medium', () => {
    const ev = makeEv({ id: 'ev3', source: 'logs', kind: 'log', relevance: 0.6 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('medium');
  });

  it('info log (relevance 0.3) → severity info', () => {
    const ev = makeEv({ id: 'ev4', source: 'logs', kind: 'log', relevance: 0.3 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Queue (BullMQ) — source: 'queue', kind: 'queue-state' or 'queue-edge'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — queue provider', () => {
  it('severe backlog (relevance 0.88) → category queue, severity high', () => {
    const ev = makeEv({ id: 'ev5', source: 'queue', kind: 'queue-state', relevance: 0.88 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('queue');
    expect(ev.severity).toBe('high');
  });

  it('starvation signal (relevance 0.7) → severity medium', () => {
    const ev = makeEv({ id: 'ev6', source: 'queue', kind: 'queue-state', relevance: 0.7 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('medium');
  });

  it('summary signal (relevance 0.4) → severity low', () => {
    const ev = makeEv({ id: 'ev7', source: 'queue', kind: 'queue-state', relevance: 0.4 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('low');
  });

  it('queue-edge (structural) → category queue, severity info', () => {
    const ev = makeEv({ id: 'ev8', source: 'queue', kind: 'queue-edge', relevance: 0.75 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('queue');
    expect(ev.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Database (MongoDB) — source: 'state', kind: 'state'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — database (MongoDB) provider', () => {
  it('anomalous status (relevance 0.85) → category database, severity high', () => {
    const ev = makeEv({ id: 'ev9', source: 'state', kind: 'state', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('database');
    expect(ev.severity).toBe('high');
  });

  it('relevant stale collection (relevance 0.5, non-legacy hint match) → severity low', () => {
    const ev = makeEv({ id: 'ev10', source: 'state', kind: 'state', relevance: 0.5 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('low');
  });

  it('legacy/irrelevant collection (relevance 0.25) → severity info', () => {
    const ev = makeEv({ id: 'ev11', source: 'state', kind: 'state', relevance: 0.25 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Code (Axon) — source: 'code', kinds: symbol, flow, impact
// ---------------------------------------------------------------------------

describe('normalizeEvidence — code provider', () => {
  it('symbol (high relevance) → category code, severity info (structural)', () => {
    const ev = makeEv({ id: 'ev12', source: 'code', kind: 'symbol', relevance: 0.9 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('code');
    expect(ev.severity).toBe('info');
  });

  it('flow → always info regardless of relevance', () => {
    const ev = makeEv({ id: 'ev13', source: 'code', kind: 'flow', relevance: 1.0 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('info');
  });

  it('impact → always info regardless of relevance', () => {
    const ev = makeEv({ id: 'ev14', source: 'code', kind: 'impact', relevance: 0.8 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Deployment (Git) — source: 'history', kind: 'commit'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — deployment (git) provider', () => {
  it('ordinary commit (relevance 0.65) → category deployment, severity info', () => {
    const ev = makeEv({ id: 'ev15', source: 'history', kind: 'commit', relevance: 0.65 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('deployment');
    expect(ev.severity).toBe('info');
  });

  it('high-signal commit (relevance 0.85) → severity medium', () => {
    const ev = makeEv({ id: 'ev16', source: 'history', kind: 'commit', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Cache (Redis) — source: 'state', kind: 'redis-key'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — cache (Redis) provider', () => {
  it('redis-key → category cache, not database', () => {
    const ev = makeEv({ id: 'ev-redis-1', source: 'state', kind: 'redis-key', relevance: 0.5 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('cache');
  });

  it('redis-key (high relevance) → severity still derived from relevance', () => {
    const ev = makeEv({ id: 'ev-redis-2', source: 'state', kind: 'redis-key', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('cache');
    expect(ev.severity).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Normalization contract
// ---------------------------------------------------------------------------

describe('normalizeEvidence — contract', () => {
  it('returns the same array reference', () => {
    const evs = [makeEv({ id: 'ev17', source: 'logs', kind: 'log', relevance: 0.9 })];
    const result = normalizeEvidence(evs);
    expect(result).toBe(evs);
  });

  it('is idempotent: running twice produces the same values', () => {
    const ev = makeEv({ id: 'ev18', source: 'queue', kind: 'queue-state', relevance: 0.88 });
    normalizeEvidence([ev]);
    const cat = ev.category;
    const sev = ev.severity;
    normalizeEvidence([ev]);
    expect(ev.category).toBe(cat);
    expect(ev.severity).toBe(sev);
  });

  it('preserves explicitly set severity and category', () => {
    const ev = makeEv({ id: 'ev19', source: 'queue', kind: 'queue-state', relevance: 0.88,
      severity: 'low', category: 'other' });
    normalizeEvidence([ev]);
    expect(ev.severity).toBe('low');
    expect(ev.category).toBe('other');
  });

  it('handles an empty array without throwing', () => {
    expect(() => normalizeEvidence([])).not.toThrow();
  });

  it('normalizes a mixed batch from multiple providers', () => {
    const evs = [
      makeEv({ id: 'a', source: 'logs', kind: 'log', relevance: 1.0 }),
      makeEv({ id: 'b', source: 'queue', kind: 'queue-state', relevance: 0.7 }),
      makeEv({ id: 'c', source: 'state', kind: 'state', relevance: 0.85 }),
      makeEv({ id: 'd', source: 'code', kind: 'symbol', relevance: 0.9 }),
    ];
    normalizeEvidence(evs);
    const [log, queue, db, code] = evs;
    expect(log!.category).toBe('logs');
    expect(queue!.category).toBe('queue');
    expect(db!.category).toBe('database');
    expect(code!.category).toBe('code');
    expect(log!.severity).toBe('critical');
    expect(queue!.severity).toBe('medium');
    expect(db!.severity).toBe('high');
    expect(code!.severity).toBe('info');
  });
});
