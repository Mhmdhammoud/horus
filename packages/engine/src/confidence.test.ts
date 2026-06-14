/**
 * HOR-45 — Unit tests for computeWeightedEvidenceConfidence (pure function).
 *
 * Tests the formula directly, bypassing investigate() so gap ceiling cannot
 * mask whether the source-cap actually works.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import { computeWeightedEvidenceConfidence } from './confidence.js';

function makeEv(
  kind: Evidence['kind'],
  source: Evidence['source'],
  relevance: number,
): Evidence {
  return {
    id: globalThis.crypto.randomUUID(),
    source,
    kind,
    title: `test ${kind}`,
    relevance,
    payload: {},
    links: {},
    provenance: { query: 'test', collectedAt: new Date().toISOString() },
  };
}

describe('computeWeightedEvidenceConfidence', () => {
  it('returns 0 for an empty evidence set', () => {
    expect(computeWeightedEvidenceConfidence([])).toBe(0);
  });

  it('single runtime item at full relevance contributes 1.5/6 ≈ 0.25', () => {
    const result = computeWeightedEvidenceConfidence([
      makeEv('log', 'logs', 1.0),
    ]);
    expect(result).toBeCloseTo(1.5 / 6, 5);
  });

  it('single structural item at full relevance contributes 0.5/6 ≈ 0.083', () => {
    const result = computeWeightedEvidenceConfidence([
      makeEv('symbol', 'code', 1.0),
    ]);
    expect(result).toBeCloseTo(0.5 / 6, 5);
  });

  it('runtime per-source cap: adding more records from the same source does not increase confidence beyond 2.0/6', () => {
    // Each queue-state item at relevance 1.0 contributes 1.5 to the runtime bucket.
    // Two items = 3.0, but runtime source cap is 2.0. Capped at 2.0/6.
    const two = computeWeightedEvidenceConfidence([
      makeEv('queue-state', 'queue', 1.0),
      makeEv('queue-state', 'queue', 1.0),
    ]);
    const ten = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => makeEv('queue-state', 'queue', 1.0)),
    );
    // Both are capped at the same value.
    expect(two).toBeCloseTo(ten, 5);
    expect(two).toBeCloseTo(2.0 / 6, 5);
  });

  it('structural per-source cap: many code-graph records are capped at 0.6/6 — far below runtime cap', () => {
    // Each symbol item at relevance 1.0 contributes 0.5 to the structural bucket.
    // 2 items → 1.0, but structural cap is 0.6. So result = 0.6/6.
    const ten = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => makeEv('symbol', 'code', 1.0)),
    );
    expect(ten).toBeCloseTo(0.6 / 6, 5);
  });

  it('many structural records produce lower confidence than equivalent many runtime records', () => {
    // Even saturating the structural cap produces less than saturating the runtime cap.
    const manyStructural = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => makeEv('symbol', 'code', 1.0)),
    );
    const manyRuntime = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => makeEv('log', 'logs', 1.0)),
    );
    // Structural: capped at 0.6/6 ≈ 0.1; Runtime: capped at 2.0/6 ≈ 0.333
    expect(manyStructural).toBeLessThan(manyRuntime);
    expect(manyStructural).toBeCloseTo(0.6 / 6, 5);
    expect(manyRuntime).toBeCloseTo(2.0 / 6, 5);
  });

  it('adding an independent runtime source increases confidence beyond the capped single-source value', () => {
    const oneSource = computeWeightedEvidenceConfidence(
      Array.from({ length: 10 }, () => makeEv('queue-state', 'queue', 1.0)),
    );
    const twoSources = computeWeightedEvidenceConfidence([
      ...Array.from({ length: 10 }, () => makeEv('queue-state', 'queue', 1.0)),
      makeEv('log', 'logs', 1.0),
    ]);
    expect(twoSources).toBeGreaterThan(oneSource);
  });

  it('low-relevance summary contributes less than a high-relevance anomaly from the same source', () => {
    const summaryOnly = computeWeightedEvidenceConfidence([
      makeEv('queue-state', 'queue', 0.4),  // summary: low relevance
    ]);
    const anomalyOnly = computeWeightedEvidenceConfidence([
      makeEv('queue-state', 'queue', 0.88), // severe backlog: high relevance
    ]);
    expect(anomalyOnly).toBeGreaterThan(summaryOnly);
    // Summary contributes 0.4*1.5/6 = 0.10; anomaly contributes 0.88*1.5/6 = 0.22
    expect(summaryOnly).toBeCloseTo(0.4 * 1.5 / 6, 5);
    expect(anomalyOnly).toBeCloseTo(0.88 * 1.5 / 6, 5);
  });

  it('a verbose BullMQ snapshot (5 derived signals) is capped at 2.0/6 — cannot saturate evidence confidence', () => {
    // Models what a real verbose snapshot emits:
    // worker-starvation (0.7), oldest-job severe (0.85), failed-spike severe (0.85),
    // failed-breakdown (0.82), summary (0.4) — all source='queue'
    const verboseSnapshot = [
      makeEv('queue-state', 'queue', 0.70),  // worker-starvation
      makeEv('queue-state', 'queue', 0.85),  // oldest-job (severe)
      makeEv('queue-state', 'queue', 0.85),  // failed-spike (severe)
      makeEv('queue-state', 'queue', 0.82),  // failed-breakdown
      makeEv('queue-state', 'queue', 0.40),  // summary
    ];
    const result = computeWeightedEvidenceConfidence(verboseSnapshot);
    // 5 items contribute 0.7+0.85+0.85+0.82+0.4 = 3.62 × 1.5 = 5.43, but capped at 2.0.
    expect(result).toBeCloseTo(2.0 / 6, 5);
    // Nowhere near saturation (1.0).
    expect(result).toBeLessThan(0.4);
  });

  it('three independent high-quality runtime sources reach ≈ 5/6 evidence confidence', () => {
    const result = computeWeightedEvidenceConfidence([
      makeEv('log', 'logs', 1.0),      // contributes 1.5 (below runtime cap)
      makeEv('metric', 'metrics', 1.0),
      makeEv('queue-state', 'queue', 1.0),
      makeEv('queue-state', 'queue', 0.9),  // same source — adds to 'queue' bucket toward cap
    ]);
    // logs: 1.5, metrics: 1.5, queue: min(1.5+1.35, 2.0)=2.0 → total 5.0/6 ≈ 0.833
    expect(result).toBeCloseTo(5.0 / 6, 5);
  });
});
