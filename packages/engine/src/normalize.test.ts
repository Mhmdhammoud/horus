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
  it('fatal log (relevance 1.0) → category logs, priority critical', () => {
    const ev = makeEv({ id: 'ev1', source: 'logs', kind: 'log', relevance: 1.0,
      title: '[fatal] auth: unhandled exception' });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('logs');
    expect(ev.priority).toBe('critical');
  });

  it('error log (relevance 0.9) → priority critical', () => {
    const ev = makeEv({ id: 'ev2', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('critical');
  });

  it('warn log (relevance 0.6) → priority medium', () => {
    const ev = makeEv({ id: 'ev3', source: 'logs', kind: 'log', relevance: 0.6 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('medium');
  });

  it('info log (relevance 0.3) → priority info', () => {
    const ev = makeEv({ id: 'ev4', source: 'logs', kind: 'log', relevance: 0.3 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Queue (BullMQ) — source: 'queue', kind: 'queue-state' or 'queue-edge'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — queue provider', () => {
  it('severe backlog (relevance 0.88) → category queue, priority high', () => {
    const ev = makeEv({ id: 'ev5', source: 'queue', kind: 'queue-state', relevance: 0.88 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('queue');
    expect(ev.priority).toBe('high');
  });

  it('starvation signal (relevance 0.7) → priority medium', () => {
    const ev = makeEv({ id: 'ev6', source: 'queue', kind: 'queue-state', relevance: 0.7 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('medium');
  });

  it('summary signal (relevance 0.4) → priority info (healthy snapshot, not an anomaly)', () => {
    const ev = makeEv({ id: 'ev7', source: 'queue', kind: 'queue-state', relevance: 0.4 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });

  it('queue-edge (structural) → category queue, priority info', () => {
    const ev = makeEv({ id: 'ev8', source: 'queue', kind: 'queue-edge', relevance: 0.75 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('queue');
    expect(ev.priority).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Database (MongoDB) — source: 'state', kind: 'state'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — database (MongoDB) provider', () => {
  it('anomalous status (relevance 0.85) → category database, priority high', () => {
    const ev = makeEv({ id: 'ev9', source: 'state', kind: 'state', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('database');
    expect(ev.priority).toBe('high');
  });

  it('stale collection (relevance 0.5) → priority info (context, not a broken system)', () => {
    const ev = makeEv({ id: 'ev10', source: 'state', kind: 'state', relevance: 0.5 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });

  it('legacy/irrelevant collection (relevance 0.25) → priority info', () => {
    const ev = makeEv({ id: 'ev11', source: 'state', kind: 'state', relevance: 0.25 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Code (source intelligence) — source: 'code', kinds: symbol, flow, impact
// ---------------------------------------------------------------------------

describe('normalizeEvidence — code provider', () => {
  it('symbol (high relevance) → category code, priority info (structural)', () => {
    const ev = makeEv({ id: 'ev12', source: 'code', kind: 'symbol', relevance: 0.9 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('code');
    expect(ev.priority).toBe('info');
  });

  it('flow → always info regardless of relevance', () => {
    const ev = makeEv({ id: 'ev13', source: 'code', kind: 'flow', relevance: 1.0 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });

  it('impact → always info regardless of relevance', () => {
    const ev = makeEv({ id: 'ev14', source: 'code', kind: 'impact', relevance: 0.8 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Deployment (Git) — source: 'history', kind: 'commit'
// ---------------------------------------------------------------------------

describe('normalizeEvidence — deployment (git) provider', () => {
  it('ordinary commit (relevance 0.65) → category deployment, priority info', () => {
    const ev = makeEv({ id: 'ev15', source: 'history', kind: 'commit', relevance: 0.65 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('deployment');
    expect(ev.priority).toBe('info');
  });

  it('high-signal commit (relevance 0.85) → priority medium', () => {
    const ev = makeEv({ id: 'ev16', source: 'history', kind: 'commit', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('medium');
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

  it('redis-key (high relevance) → priority still derived from relevance', () => {
    const ev = makeEv({ id: 'ev-redis-2', source: 'state', kind: 'redis-key', relevance: 0.85 });
    normalizeEvidence([ev]);
    expect(ev.category).toBe('cache');
    expect(ev.priority).toBe('high');
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
    const sev = ev.priority;
    normalizeEvidence([ev]);
    expect(ev.category).toBe(cat);
    expect(ev.priority).toBe(sev);
  });

  it('preserves explicitly set priority and category', () => {
    const ev = makeEv({ id: 'ev19', source: 'queue', kind: 'queue-state', relevance: 0.88,
      priority: 'low', category: 'other' });
    normalizeEvidence([ev]);
    expect(ev.priority).toBe('low');
    expect(ev.category).toBe('other');
  });

  it('handles an empty array without throwing', () => {
    expect(() => normalizeEvidence([])).not.toThrow();
  });

  it('does not stamp a subject when no context is supplied', () => {
    const ev = makeEv({ id: 'ev-no-ctx', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev]);
    expect(ev.subject).toBeUndefined();
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
    expect(log!.priority).toBe('critical');
    expect(queue!.priority).toBe('medium');
    expect(db!.priority).toBe('high');
    expect(code!.priority).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Subject derivation (Stage 0)
// ---------------------------------------------------------------------------

describe('normalizeEvidence — subject derivation', () => {
  it('stamps service + environment from the investigation scope', () => {
    const ev = makeEv({ id: 's1', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev], { service: 'checkout', environment: 'production' });
    expect(ev.subject).toEqual({ service: 'checkout', environment: 'production' });
  });

  it('omits the missing dimension (service-only scope)', () => {
    const ev = makeEv({ id: 's2', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev], { service: 'checkout' });
    expect(ev.subject).toEqual({ service: 'checkout' });
    expect(ev.subject!.environment).toBeUndefined();
  });

  it('omits the missing dimension (environment-only scope)', () => {
    const ev = makeEv({ id: 's3', source: 'metrics', kind: 'metric', relevance: 0.9 });
    normalizeEvidence([ev], { environment: 'staging' });
    expect(ev.subject).toEqual({ environment: 'staging' });
  });

  it('stays inert when the context resolves to no real values', () => {
    const ev = makeEv({ id: 's4', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([ev], { service: '', environment: '' });
    expect(ev.subject).toBeUndefined();
  });

  it('preserves an explicitly set subject (idempotent)', () => {
    const ev = makeEv({ id: 's5', source: 'logs', kind: 'log', relevance: 0.9,
      subject: { service: 'pre-set' } });
    normalizeEvidence([ev], { service: 'checkout', environment: 'production' });
    expect(ev.subject).toEqual({ service: 'pre-set' });
  });

  it('gives each item its own subject object (no shared reference)', () => {
    const a = makeEv({ id: 's6a', source: 'logs', kind: 'log', relevance: 0.9 });
    const b = makeEv({ id: 's6b', source: 'logs', kind: 'log', relevance: 0.9 });
    normalizeEvidence([a, b], { service: 'checkout' });
    expect(a.subject).toEqual(b.subject);
    expect(a.subject).not.toBe(b.subject);
  });
});

describe('normalizeEvidence — subject is additive (priority/category untouched)', () => {
  const fresh = () => [
    makeEv({ id: 'a', source: 'logs', kind: 'log', relevance: 1.0 }),
    makeEv({ id: 'b', source: 'queue', kind: 'queue-state', relevance: 0.7 }),
    makeEv({ id: 'c', source: 'state', kind: 'state', relevance: 0.85 }),
    makeEv({ id: 'd', source: 'code', kind: 'symbol', relevance: 0.9 }),
  ];

  it('priority/category are identical with and without a subject context', () => {
    const without = fresh();
    normalizeEvidence(without);
    const withCtx = fresh();
    normalizeEvidence(withCtx, { service: 'checkout', environment: 'production' });

    // Stripping the new subject field, the normalized rows are byte-identical —
    // proving the subject context never perturbs the priority/category outputs.
    const strip = (evs: typeof without) =>
      evs.map(({ subject: _subject, ...rest }) => rest);
    expect(strip(withCtx)).toEqual(strip(without));

    // And the subject is present only on the context-supplied run.
    expect(without.every((e) => e.subject === undefined)).toBe(true);
    expect(withCtx.every((e) => e.subject?.service === 'checkout')).toBe(true);
  });
});
