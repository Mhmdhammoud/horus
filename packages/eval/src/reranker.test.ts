import { describe, it, expect } from 'vitest';
import {
  trainReranker,
  applyReranker,
  deriveLabels,
  collectFeatureKeys,
  extractRawFeatures,
  matchesConfirmedCause,
  baselineTop,
  MIN_TRAIN_INVESTIGATIONS,
  type RankableCause,
  type RerankInvestigation,
} from './reranker.js';

function cause(id: string, title: string, finalScore: number, good: number): RankableCause {
  return {
    id,
    title,
    category: 'cat',
    finalScore,
    confidence: finalScore,
    baseScore: 0.5,
    sourceEvidenceIds: [],
    affectedNodeIds: [],
    explanations: [{ factor: 'good', delta: good, reason: '' }],
  };
}

// A separable world: candidate 'a' has the HIGHER finalScore (so the baseline always points at it)
// but is WRONG; candidate 'b' is the real cause, identifiable only by the `good` factor. A reranker
// that learns `good` should beat the baseline on a holdout.
const pair = (): RankableCause[] => [cause('a', 'wrong cause', 0.9, 0), cause('b', 'real database deadlock', 0.3, 1)];
const investigations = (n: number): RerankInvestigation[] =>
  Array.from({ length: n }, (_, i) => ({
    investigationId: `inv-${i}`,
    target: 'yes' as const,
    confirmedCause: 'database deadlock', // matches 'b' → b is the known-correct candidate
    candidates: pair(),
  }));

describe('feature extraction', () => {
  it('collectFeatureKeys = fixed scalars + sorted f:<factor> union', () => {
    const keys = collectFeatureKeys(investigations(1));
    expect(keys).toEqual(['finalScore', 'confidence', 'baseScore', 'evidenceCount', 'affectedCount', 'f:good']);
  });

  it('extractRawFeatures reads scalars + summed factor deltas in schema order', () => {
    const keys = collectFeatureKeys(investigations(1));
    expect(extractRawFeatures(cause('b', 'real database deadlock', 0.3, 1), keys)).toEqual([0.3, 0.3, 0.5, 0, 0, 1]);
  });
});

describe('matchesConfirmedCause', () => {
  it('scores token overlap of confirmedCause within the candidate title/category', () => {
    const b = cause('b', 'real database deadlock', 0.3, 1);
    expect(matchesConfirmedCause('database deadlock', b)).toBeCloseTo(1, 5);
    expect(matchesConfirmedCause('totally unrelated thing', b)).toBe(0);
  });
});

describe('deriveLabels', () => {
  it('confirmedCause path: the best-matching candidate is relevant, overriding the verdict', () => {
    const d = deriveLabels({ investigationId: 'x', target: 'no', confirmedCause: 'database deadlock', candidates: pair() });
    expect(d.relevantId).toBe('b');
    expect(d.examples.find((e) => e.cause.id === 'b')!.label).toBe(1);
    expect(d.examples.find((e) => e.cause.id === 'a')!.label).toBe(0);
  });

  it('target=yes, no cause: the baseline headline is relevant', () => {
    const d = deriveLabels({ investigationId: 'x', target: 'yes', confirmedCause: null, candidates: pair() });
    expect(d.relevantId).toBe('a'); // baselineTop by finalScore
    expect(d.examples.find((e) => e.cause.id === 'a')!.label).toBe(1);
  });

  it('target=no, no cause: only a confirmed negative on the headline, no relevant id', () => {
    const d = deriveLabels({ investigationId: 'x', target: 'no', confirmedCause: null, candidates: pair() });
    expect(d.relevantId).toBeNull();
    expect(d.examples).toEqual([{ cause: expect.objectContaining({ id: 'a' }), label: 0 }]);
  });

  it('target=partly, no cause: ambiguous → no examples', () => {
    const d = deriveLabels({ investigationId: 'x', target: 'partly', confirmedCause: null, candidates: pair() });
    expect(d.relevantId).toBeNull();
    expect(d.examples).toEqual([]);
  });
});

describe('baselineTop', () => {
  it('picks max finalScore, tie-broken by id asc', () => {
    expect(baselineTop(pair())!.id).toBe('a');
    expect(baselineTop([cause('z', 't', 0.5, 0), cause('a', 't', 0.5, 0)])!.id).toBe('a');
  });
});

describe('trainReranker', () => {
  it('refuses under the min-corpus gate', () => {
    const res = trainReranker(investigations(10), new Set(['inv-0', 'inv-1']));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('insufficient-corpus');
  });

  it('learns to beat the baseline on a holdout when a feature separates the correct candidate', () => {
    const all = investigations(40);
    const holdoutIds = new Set(Array.from({ length: 8 }, (_, i) => `inv-${i}`));
    const res = trainReranker(all, holdoutIds);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Baseline always picks the higher-finalScore (wrong) candidate.
      expect(res.holdout.baselineHitRate).toBe(0);
      // The reranker learns `good` and recovers the right candidate.
      expect(res.holdout.rerankedHitRate).toBeGreaterThan(res.holdout.baselineHitRate);
      expect(res.holdout.delta).toBeGreaterThan(0);
      expect(res.holdout.n).toBe(8);
    }
  });
});

describe('applyReranker — reorder only, never mutate', () => {
  it('reorders by learned score and leaves candidate scores untouched', () => {
    const res = trainReranker(investigations(40), new Set(['inv-0', 'inv-1', 'inv-2']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const input = pair();
    const before = input.map((c) => ({ id: c.id, finalScore: c.finalScore, confidence: c.confidence }));
    const out = applyReranker(res, input);
    expect(out[0]?.id).toBe('b'); // the real cause floats up
    // No mutation of the inputs' scores.
    expect(input.map((c) => ({ id: c.id, finalScore: c.finalScore, confidence: c.confidence }))).toEqual(before);
    // Same set of candidates, just reordered.
    expect(out.map((c) => c.id).sort()).toEqual(['a', 'b']);
  });
});
