/**
 * End-to-end confirmation of the HOR-404 reranker pipeline using the REAL functions across packages:
 *   trainReranker → JSON round-trip (the ~/.horus/reranker.json artifact) → isRerankerModel guard →
 *   applyReranker → the REAL engine `selectHeadlineCause` seam.
 *
 * It overfits a tiny synthetic corpus on purpose — the goal is to prove the mechanism works end to
 * end (a trained model actually changes which eligible cause the engine headlines), not to measure
 * accuracy. The honesty bound is also exercised: the reranker only flips the headline among causes
 * that already clear the engine's gates.
 */
import { describe, it, expect } from 'vitest';
import { selectHeadlineCause, type CauseCandidate } from '@horus/engine';
import {
  trainReranker,
  applyReranker,
  isRerankerModel,
  type RerankInvestigation,
} from './reranker.js';
import { holdoutSplit } from './corpus.js';

// Two ELIGIBLE, seed-linked causes. The baseline points at `wrong` (higher finalScore); the real
// cause `right` is identifiable only by the `good` factor — exactly what a reranker should learn.
function makeCauses(): CauseCandidate[] {
  return [
    {
      id: 'wrong',
      title: 'higher-scored but wrong',
      category: 'other',
      sourceEvidenceIds: ['ev_seed'],
      affectedNodeIds: [],
      baseScore: 0.7,
      finalScore: 0.7,
      confidence: 0.7,
      band: 'likely',
      explanations: [{ factor: 'good', delta: 0, reason: '' }],
    },
    {
      id: 'right',
      title: 'real database deadlock',
      category: 'other',
      sourceEvidenceIds: ['ev_seed'],
      affectedNodeIds: [],
      baseScore: 0.4,
      finalScore: 0.4,
      confidence: 0.4,
      band: 'possible',
      explanations: [{ factor: 'good', delta: 1, reason: '' }],
    },
  ];
}

const isLinked = (ids: string[]): boolean => ids.includes('ev_seed');

describe('HOR-404 reranker — end-to-end pipeline confirmation', () => {
  it('trains a model, round-trips it as JSON, and flips the engine headline to the learned cause', () => {
    // 1. Synthetic per-tenant corpus: confirmedCause points at `right`.
    const corpus: RerankInvestigation[] = Array.from({ length: 40 }, (_, i) => ({
      investigationId: `inv-${i}`,
      target: 'yes' as const,
      confirmedCause: 'database deadlock',
      candidates: makeCauses(),
    }));

    // 2. REAL training over a deterministic holdout split.
    const split = holdoutSplit(corpus);
    const trained = trainReranker(corpus, new Set(split.holdout));
    expect(trained.ok).toBe(true);
    if (!trained.ok) return;
    // It actually learned: reranked top-1 beats the (always-wrong) baseline on the holdout.
    expect(trained.holdout.delta).toBeGreaterThan(0);

    // 3. The artifact path: serialize → parse → validate, exactly like horus train → investigate.
    const { ok: _ok, ...model } = trained;
    void _ok;
    const roundTripped: unknown = JSON.parse(JSON.stringify(model));
    expect(isRerankerModel(roundTripped)).toBe(true);
    if (!isRerankerModel(roundTripped)) return;

    // 4. Build the engine `rerank` fn from the loaded model and run the REAL headline seam.
    const rerank = (causes: readonly CauseCandidate[]): CauseCandidate[] => applyReranker(roundTripped, causes);
    const causes = makeCauses();

    // Baseline (no model): the engine headlines the higher-finalScore `wrong` cause.
    expect(selectHeadlineCause(causes, isLinked).headlineCause?.id).toBe('wrong');

    // With the trained model: the engine headlines the learned-correct `right` cause...
    const r = selectHeadlineCause(causes, isLinked, rerank);
    expect(r.headlineCause?.id).toBe('right');
    // ...while the ceiling basis (topCause) stays the finalScore argmax — confidence never inflated.
    expect(r.topCause?.id).toBe('wrong');
    expect(r.headlineLinked).toBe(true);
  });
});
