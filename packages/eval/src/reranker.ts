/**
 * Reranker (HOR-404) — a small, honesty-constrained learned reranker that REORDERS candidate causes
 * using the per-tenant outcome-label corpus.
 *
 * It is a RANKING AID ONLY: it never fabricates evidence, never changes finalScore / confidence /
 * bands / ceilings, and (by `horus train`'s gate) ships OFF until it demonstrably beats the hand-tuned
 * baseline on a DETERMINISTIC holdout. Training is LOCAL and per-tenant — the corpus never leaves the
 * client; the model is a few kilobytes of logistic weights.
 *
 * Everything here is PURE (no DB, no fs, no clock, no RNG): the `horus train` command feeds it the
 * corpus (labels joined to reports) and persists the model JSON; `horus investigate` loads the model
 * and calls {@link applyReranker} at the reorder-safe seam.
 */
import type { CauseCandidate } from '@horus/engine';
import type { OutcomeResolved } from '@horus/db';

export const RERANKER_VERSION = 'v1' as const;

/**
 * Minimum distinct labeled investigations (with a derivable correct candidate) before training is
 * even attempted — below this a holdout is degenerate and any "win" is noise. `horus train` refuses
 * under this gate rather than fit on too little data.
 */
export const MIN_TRAIN_INVESTIGATIONS = 25;

/** Scalar features read directly off a candidate (deterministic order; prefix-free). */
const SCALAR_KEYS = ['finalScore', 'confidence', 'baseScore', 'evidenceCount', 'affectedCount'] as const;

/** The candidate fields the reranker depends on — a structural subset of `CauseCandidate`. */
export type RankableCause = Pick<
  CauseCandidate,
  | 'id'
  | 'title'
  | 'category'
  | 'finalScore'
  | 'confidence'
  | 'baseScore'
  | 'sourceEvidenceIds'
  | 'affectedNodeIds'
  | 'explanations'
>;

/** One investigation's candidates + its human verdict, the unit the reranker trains/evaluates on. */
export interface RerankInvestigation {
  investigationId: string;
  target: OutcomeResolved;
  /** Human-attested root cause (feedback only); null when absent or circular (confirm). */
  confirmedCause: string | null;
  candidates: RankableCause[];
}

/** The persisted, honesty-audited model. A few kB of JSON; written to ~/.horus/reranker.json. */
export interface RerankerModel {
  version: string;
  /** Feature schema (scalar keys + `f:<factor>` keys) — the exact order weights apply to. */
  featureKeys: string[];
  /** Standardization params captured at train time (same length as featureKeys). */
  mean: number[];
  std: number[];
  /** Learned logistic weights (same length as featureKeys) + bias. */
  weights: number[];
  bias: number;
  /** Honest holdout measurement vs the hand-tuned baseline — the ship/no-ship signal. */
  holdout: { n: number; baselineHitRate: number; rerankedHitRate: number; delta: number };
  trainExamples: number;
  trainInvestigations: number;
}

/** Why training did not produce a model (so `horus train` can report honestly). */
export interface RerankTrainSkip {
  ok: false;
  reason: 'insufficient-corpus' | 'no-derivable-labels' | 'degenerate-holdout';
  detail: string;
  labeledInvestigations: number;
}

export type RerankTrainResult = ({ ok: true } & RerankerModel) | RerankTrainSkip;

// ── Text matching (confirmedCause ↔ candidate) ───────────────────────────────

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3),
  );
}

/**
 * Does the human-attested `confirmedCause` text refer to this candidate? Token-overlap (Jaccard-ish)
 * between the confirmedCause and the candidate's title+category. Deliberately fuzzy — this only
 * derives TRAINING labels, never a verdict, and the result is validated on a holdout.
 */
export function matchesConfirmedCause(confirmedCause: string, cause: RankableCause): number {
  const a = tokenize(confirmedCause);
  const b = tokenize(`${cause.title} ${cause.category}`);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap += 1;
  return overlap / a.size; // fraction of the cause's words found among the candidate's
}

// ── Feature extraction ───────────────────────────────────────────────────────

/** The full feature schema for a candidate set: fixed scalars + the sorted union of factor ids. */
export function collectFeatureKeys(investigations: readonly RerankInvestigation[]): string[] {
  const factors = new Set<string>();
  for (const inv of investigations) {
    for (const c of inv.candidates) {
      for (const e of c.explanations ?? []) factors.add(e.factor);
    }
  }
  return [...SCALAR_KEYS, ...[...factors].sort().map((f) => `f:${f}`)];
}

/** Raw (un-standardized) feature vector for one candidate, in `featureKeys` order. */
export function extractRawFeatures(cause: RankableCause, featureKeys: readonly string[]): number[] {
  const factorDelta = new Map<string, number>();
  for (const e of cause.explanations ?? []) {
    factorDelta.set(e.factor, (factorDelta.get(e.factor) ?? 0) + e.delta);
  }
  return featureKeys.map((k) => {
    switch (k) {
      case 'finalScore':
        return cause.finalScore;
      case 'confidence':
        return cause.confidence;
      case 'baseScore':
        return cause.baseScore;
      case 'evidenceCount':
        return cause.sourceEvidenceIds?.length ?? 0;
      case 'affectedCount':
        return cause.affectedNodeIds?.length ?? 0;
      default:
        return factorDelta.get(k.slice(2)) ?? 0; // 'f:<factor>'
    }
  });
}

// ── Per-candidate label derivation ───────────────────────────────────────────

/** The headline candidate the baseline points at: max finalScore, tie-broken by id asc. */
export function baselineTop(candidates: readonly RankableCause[]): RankableCause | null {
  let best: RankableCause | null = null;
  for (const c of candidates) {
    if (best === null || c.finalScore > best.finalScore || (c.finalScore === best.finalScore && c.id < best.id)) {
      best = c;
    }
  }
  return best;
}

/**
 * Derive per-candidate relevance labels for one investigation, or null when no usable signal exists.
 * Returns the id of the KNOWN-relevant candidate (for top-1 holdout scoring) plus the 0/1 examples.
 *
 * Rules (honest — only label what we actually know):
 *  - `confirmedCause` present → the best text-matching candidate (above a floor) is relevant=1, the
 *    rest 0. This is the cleanest per-candidate signal.
 *  - else `target=yes` → the baseline headline was right: headline=1, rest=0.
 *  - else `target=no`  → the headline was WRONG: headline=0; the others are UNKNOWN (we don't know
 *    which was right) → excluded. (A negative-only row trains "this wasn't it" without guessing.)
 *  - else `target=partly` with no cause → ambiguous → no examples.
 */
export function deriveLabels(inv: RerankInvestigation): {
  relevantId: string | null;
  examples: { cause: RankableCause; label: 0 | 1 }[];
} {
  const cands = inv.candidates;
  if (cands.length === 0) return { relevantId: null, examples: [] };

  if (inv.confirmedCause && inv.confirmedCause.trim() !== '') {
    let bestId: string | null = null;
    let bestScore = 0;
    for (const c of cands) {
      const m = matchesConfirmedCause(inv.confirmedCause, c);
      if (m > bestScore) {
        bestScore = m;
        bestId = c.id;
      }
    }
    if (bestId !== null && bestScore >= 0.34) {
      return {
        relevantId: bestId,
        examples: cands.map((c) => ({ cause: c, label: c.id === bestId ? 1 : 0 })),
      };
    }
    // confirmedCause didn't match any candidate → fall through to verdict-based labeling.
  }

  const top = baselineTop(cands);
  if (top === null) return { relevantId: null, examples: [] };

  if (inv.target === 'yes') {
    return { relevantId: top.id, examples: cands.map((c) => ({ cause: c, label: c.id === top.id ? 1 : 0 })) };
  }
  if (inv.target === 'no') {
    // Only a confirmed negative on the headline; the true cause is unknown → no relevant id.
    return { relevantId: null, examples: [{ cause: top, label: 0 }] };
  }
  return { relevantId: null, examples: [] }; // partly, no cause text → ambiguous
}

// ── Logistic regression (deterministic batch gradient descent) ────────────────

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

interface TrainedWeights {
  weights: number[];
  bias: number;
}

/** Fit logistic weights on standardized features. Deterministic: zero init, fixed schedule. */
function fitLogistic(
  X: readonly number[][],
  y: readonly (0 | 1)[],
  opts: { epochs?: number; lr?: number; l2?: number } = {},
): TrainedWeights {
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.1;
  const l2 = opts.l2 ?? 0.001;
  const dim = X[0]?.length ?? 0;
  const weights = new Array<number>(dim).fill(0);
  let bias = 0;
  const n = X.length;
  if (n === 0) return { weights, bias };
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array<number>(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = bias;
      for (let j = 0; j < dim; j++) z += weights[j]! * xi[j]!;
      const err = sigmoid(z) - y[i]!;
      for (let j = 0; j < dim; j++) gradW[j] = gradW[j]! + err * xi[j]!;
      gradB += err;
    }
    for (let j = 0; j < dim; j++) weights[j] = weights[j]! - lr * (gradW[j]! / n + l2 * weights[j]!);
    bias -= lr * (gradB / n);
  }
  return { weights, bias };
}

function scoreVector(weights: readonly number[], bias: number, x: readonly number[]): number {
  let z = bias;
  for (let j = 0; j < weights.length; j++) z += weights[j]! * x[j]!;
  return z;
}

// ── Standardization ──────────────────────────────────────────────────────────

function standardizeParams(X: readonly number[][]): { mean: number[]; std: number[] } {
  const dim = X[0]?.length ?? 0;
  const mean = new Array<number>(dim).fill(0);
  const std = new Array<number>(dim).fill(0);
  if (X.length === 0) return { mean, std };
  for (const row of X) for (let j = 0; j < dim; j++) mean[j] = mean[j]! + row[j]!;
  for (let j = 0; j < dim; j++) mean[j] = mean[j]! / X.length;
  for (const row of X) for (let j = 0; j < dim; j++) std[j] = std[j]! + (row[j]! - mean[j]!) ** 2;
  for (let j = 0; j < dim; j++) std[j] = Math.sqrt(std[j]! / X.length) || 1; // guard 0 → 1
  return { mean, std };
}

function applyStandardize(x: readonly number[], mean: readonly number[], std: readonly number[]): number[] {
  return x.map((v, j) => (v - mean[j]!) / std[j]!);
}

// ── Training + holdout evaluation ────────────────────────────────────────────

/** Top-1 hit rate over a set of investigations, scoring each candidate with `score`. */
function top1HitRate(
  set: readonly { inv: RerankInvestigation; relevantId: string }[],
  score: (c: RankableCause) => number,
): number {
  if (set.length === 0) return 0;
  let hits = 0;
  for (const { inv, relevantId } of set) {
    let bestId: string | null = null;
    let bestScore = -Infinity;
    for (const c of inv.candidates) {
      const s = score(c);
      // Tie-break by id asc to stay deterministic and match baselineTop semantics.
      if (s > bestScore || (s === bestScore && bestId !== null && c.id < bestId)) {
        bestScore = s;
        bestId = c.id;
      }
    }
    if (bestId === relevantId) hits += 1;
  }
  return hits / set.length;
}

/**
 * Train the reranker on the given investigations, holding out the ids in `holdoutIds`. PURE. Returns
 * a model with an honest holdout delta vs the baseline (finalScore order), or a typed skip when the
 * corpus is too small / unlabelable to train or evaluate honestly.
 */
export function trainReranker(
  investigations: readonly RerankInvestigation[],
  holdoutIds: ReadonlySet<string>,
  opts: { epochs?: number; lr?: number; l2?: number } = {},
): RerankTrainResult {
  const labeled = investigations
    .map((inv) => ({ inv, derived: deriveLabels(inv) }))
    .filter((x) => x.derived.examples.length > 0);

  // Investigations with a KNOWN-correct candidate — the only ones a top-1 holdout can score.
  const scorable = labeled.filter((x) => x.derived.relevantId !== null && x.inv.candidates.length >= 2);

  if (scorable.length < MIN_TRAIN_INVESTIGATIONS) {
    return {
      ok: false,
      reason: 'insufficient-corpus',
      detail: `need ≥${MIN_TRAIN_INVESTIGATIONS} labeled investigations with a known-correct candidate; have ${scorable.length}`,
      labeledInvestigations: scorable.length,
    };
  }

  const featureKeys = collectFeatureKeys(investigations);

  const trainSet = scorable.filter((x) => !holdoutIds.has(x.inv.investigationId));
  const holdoutSet = scorable.filter((x) => holdoutIds.has(x.inv.investigationId));
  if (holdoutSet.length === 0 || trainSet.length === 0) {
    return {
      ok: false,
      reason: 'degenerate-holdout',
      detail: `train/holdout split left ${trainSet.length} train / ${holdoutSet.length} holdout`,
      labeledInvestigations: scorable.length,
    };
  }

  // Build the standardized training matrix from the TRAIN split only (no holdout leakage).
  const rawX: number[][] = [];
  const y: (0 | 1)[] = [];
  for (const { inv } of trainSet) {
    for (const ex of deriveLabels(inv).examples) {
      rawX.push(extractRawFeatures(ex.cause, featureKeys));
      y.push(ex.label);
    }
  }
  if (rawX.length === 0) {
    return { ok: false, reason: 'no-derivable-labels', detail: 'no training examples after split', labeledInvestigations: scorable.length };
  }
  const { mean, std } = standardizeParams(rawX);
  const X = rawX.map((row) => applyStandardize(row, mean, std));
  const { weights, bias } = fitLogistic(X, y, opts);

  const modelScore = (c: RankableCause): number =>
    scoreVector(weights, bias, applyStandardize(extractRawFeatures(c, featureKeys), mean, std));

  const holdoutScored = holdoutSet.map((x) => ({ inv: x.inv, relevantId: x.derived.relevantId as string }));
  const baselineHitRate = top1HitRate(holdoutScored, (c) => c.finalScore);
  const rerankedHitRate = top1HitRate(holdoutScored, modelScore);

  return {
    ok: true,
    version: RERANKER_VERSION,
    featureKeys,
    mean,
    std,
    weights,
    bias,
    holdout: {
      n: holdoutScored.length,
      baselineHitRate,
      rerankedHitRate,
      delta: rerankedHitRate - baselineHitRate,
    },
    trainExamples: rawX.length,
    trainInvestigations: trainSet.length,
  };
}

// ── Inference: reorder only ──────────────────────────────────────────────────

/**
 * Reorder candidates by the model's score, descending. PURE and REORDER-ONLY — it returns a new array
 * and NEVER mutates any candidate's finalScore/confidence/band. Ties (and any candidate the model
 * can't score) preserve the input order, so a no-op model leaves ordering unchanged.
 */
export function applyReranker<T extends RankableCause>(model: RerankerModel, candidates: readonly T[]): T[] {
  const scored = candidates.map((c, i) => ({
    c,
    i,
    s: scoreVector(model.weights, model.bias, applyStandardize(extractRawFeatures(c, model.featureKeys), model.mean, model.std)),
  }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i)); // score desc, stable on original index
  return scored.map((x) => x.c);
}

/** Type guard for a persisted model blob (defensive against hand-edited / legacy files). */
export function isRerankerModel(blob: unknown): blob is RerankerModel {
  if (blob === null || typeof blob !== 'object') return false;
  const m = blob as Partial<RerankerModel>;
  return (
    Array.isArray(m.featureKeys) &&
    Array.isArray(m.weights) &&
    Array.isArray(m.mean) &&
    Array.isArray(m.std) &&
    typeof m.bias === 'number' &&
    m.weights.length === m.featureKeys.length
  );
}
