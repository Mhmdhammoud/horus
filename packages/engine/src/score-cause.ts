/**
 * HOR-15 — Cause Scoring Engine v2.
 *
 * Replaces scattered heuristic scoring with principled, explainable
 * multi-factor scoring. Every boost/penalty produces a human-readable
 * explanation. Scores map to four confidence bands.
 */

import type { Evidence } from '@horus/core';
import type { InvestigationGraph } from './graph.js';
import { maxImplicationScore } from './graph.js';

// ── Bands ──────────────────────────────────────────────────────────────────

/** Qualitative confidence band for a scored cause. */
export type CauseBand =
  | 'highly-likely'   // finalScore ≥ 0.85
  | 'likely'          // finalScore ≥ 0.65
  | 'possible'        // finalScore ≥ 0.40
  | 'observation';    // finalScore < 0.40

// ── Types ──────────────────────────────────────────────────────────────────

/** One factor's contribution to the final score. */
export interface ScoreExplanation {
  /** Stable identifier for the factor, e.g. 'evidence-quality'. */
  factor: string;
  /** Signed score adjustment (positive = boost, negative = penalty). */
  delta: number;
  /** Human-readable justification. */
  reason: string;
}

/** A fully scored cause candidate, ready for ranking and report inclusion. */
export interface CauseCandidate {
  /** Caller-assigned ID; deterministic within a single investigation run. */
  id: string;
  /** Human-readable title of the cause. */
  title: string;
  /** Coarse cause category, e.g. 'queue-backlog', 'deployment-regression'. */
  category: string;
  /** Evidence item IDs that directly support this cause. */
  sourceEvidenceIds: string[];
  /** Graph node IDs implicated by this cause (optional; derived from graph). */
  affectedNodeIds: string[];
  /** Heuristic prior score before factor adjustments (0–1). */
  baseScore: number;
  /** Final score after all factor adjustments, clamped to 0–1. */
  finalScore: number;
  /** Alias for finalScore; kept as a separate field for future divergence. */
  confidence: number;
  /** Qualitative band derived from finalScore. */
  band: CauseBand;
  /** Ordered list of factor contributions; empty when no factors fired. */
  explanations: ScoreExplanation[];
  /** Arbitrary caller-supplied context (blast radius, wait count, etc.). */
  metadata?: Record<string, unknown>;
}

/** Caller-supplied input for a cause to be scored. */
export interface CauseInput {
  /** Stable within-run identifier. */
  id: string;
  title: string;
  category: string;
  sourceEvidenceIds: string[];
  /** Optional graph node IDs; if omitted, defaults to []. */
  affectedNodeIds?: string[];
  /**
   * Heuristic prior probability (0–1). Encodes domain-specific knowledge such
   * as queue wait count or whether a deployment is implicated. The scoring
   * factors adjust from this baseline.
   */
  baseScore: number;
  metadata?: Record<string, unknown>;
}

/** Contextual data the scorer uses to compute factor adjustments. */
export interface ScoringContext {
  /** Normalized evidence from the current investigation. */
  evidence: Evidence[];
  /** Infrastructure topology derived from evidence (HOR-14). */
  graph: InvestigationGraph;
  /**
   * Reference timestamp for recency calculations. Defaults to now if omitted.
   * Inject a fixed value in tests to ensure determinism.
   */
  now?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Weight applied to evidence priority when computing the quality factor. */
const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 1.00,
  high: 0.90,
  medium: 0.75,
  low: 0.50,
  info: 0.15,
};

/** Evidence kinds that provide only structural/topology information. */
const STRUCTURAL_KINDS: ReadonlySet<string> = new Set([
  'symbol', 'flow', 'impact', 'queue-edge',
]);

// ── Helpers ────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function getBand(score: number): CauseBand {
  if (score >= 0.85) return 'highly-likely';
  if (score >= 0.65) return 'likely';
  if (score >= 0.40) return 'possible';
  return 'observation';
}

// ── Factor functions ───────────────────────────────────────────────────────

/**
 * Factor 1 — Evidence quality (severity × confidence).
 *
 * Computes a priority-weighted average relevance of non-structural evidence
 * and returns the deviation from a 0.5 neutral baseline. All-info-priority
 * evidence incurs a small penalty.
 */
function factorEvidenceQuality(items: Evidence[]): ScoreExplanation | null {
  const scored = items.filter(
    (ev) => ev.priority !== undefined && ev.priority !== 'info',
  );
  if (scored.length === 0) {
    if (items.length === 0) return null;
    return {
      factor: 'evidence-quality',
      delta: -0.05,
      reason: 'All attached evidence has info priority — no anomaly signal present',
    };
  }
  const total = scored.reduce((sum, ev) => {
    const w = PRIORITY_WEIGHT[ev.priority!] ?? 0.5;
    return sum + w * ev.relevance;
  }, 0);
  const avg = total / scored.length;
  const delta = +(avg - 0.5).toFixed(3);
  if (Math.abs(delta) < 0.01) return null;
  const sign = delta > 0 ? '+' : '';
  return {
    factor: 'evidence-quality',
    delta,
    reason: `${scored.length} anomaly evidence item(s); priority-weighted quality ${avg.toFixed(2)} (${sign}${delta.toFixed(2)} vs 0.50 baseline)`,
  };
}

/**
 * Factor 2 — Source diversity (independent corroboration).
 *
 * Multiple independent provider kinds strengthen confidence in the cause.
 */
function factorSourceDiversity(items: Evidence[]): ScoreExplanation | null {
  const sources = new Set(items.map((e) => e.source));
  const count = sources.size;
  if (count <= 1) return null;
  const delta = count === 2 ? 0.05 : 0.10;
  const names = [...sources].sort().join(', ');
  return {
    factor: 'source-diversity',
    delta,
    reason: `Evidence from ${count} independent providers (${names}) — multi-source corroboration`,
  };
}

/**
 * Factor 3 — Graph proximity (infrastructure implication).
 *
 * Infrastructure nodes implicated by this cause's evidence boost the score.
 * Delegates to `maxImplicationScore()` which filters to implicated-only nodes.
 */
function factorGraphProximity(
  sourceEvidenceIds: string[],
  graph: InvestigationGraph,
): ScoreExplanation | null {
  const score = maxImplicationScore(graph, sourceEvidenceIds);
  if (score <= 0) return null;
  const delta = +(score * 0.10).toFixed(3);
  return {
    factor: 'graph-proximity',
    delta,
    reason: `Infrastructure node implication score ${score.toFixed(2)} → graph-confirmed path (+${(delta * 100).toFixed(0)}%)`,
  };
}

/**
 * Factor 4 — Runtime signals (recency + recurrence).
 *
 * Recent evidence and new/spiking error signatures increase confidence.
 */
function factorRuntimeSignals(items: Evidence[], now: string): ScoreExplanation | null {
  const nowMs = new Date(now).getTime();
  let recencyDelta = 0;
  let recencyReason = '';

  const timestamps = items
    .filter((e) => e.timestamp !== undefined)
    .map((e) => new Date(e.timestamp!).getTime())
    .sort((a, b) => b - a);

  const newestTs = timestamps[0];
  if (newestTs !== undefined) {
    const ageMs = nowMs - newestTs;
    if (ageMs <= 3_600_000) {
      recencyDelta = 0.05;
      recencyReason = 'Evidence from within the last hour';
    } else if (ageMs <= 86_400_000) {
      recencyDelta = 0.02;
      recencyReason = 'Evidence from within the last 24 hours';
    }
  }

  let recurrenceDelta = 0;
  let recurrenceReason = '';
  for (const ev of items.filter((e) => e.kind === 'log')) {
    if (ev.isNew === true) {
      recurrenceDelta = Math.max(recurrenceDelta, 0.05);
      recurrenceReason = 'New error signature (isNew=true)';
    } else if (typeof ev.ratio === 'number' && ev.ratio >= 3.0) {
      recurrenceDelta = Math.max(recurrenceDelta, 0.03);
      recurrenceReason = `Error spike (ratio ${ev.ratio.toFixed(1)}×)`;
    }
  }

  const delta = +(recencyDelta + recurrenceDelta).toFixed(3);
  if (delta <= 0) return null;

  const parts: string[] = [];
  if (recencyReason) parts.push(recencyReason);
  if (recurrenceReason) parts.push(recurrenceReason);
  return { factor: 'runtime-signals', delta, reason: parts.join('; ') };
}

/**
 * Factor 5 — Blast radius.
 *
 * A larger fan-out of affected symbols increases the probability that a fault
 * here propagates widely. Contribution capped at +0.05 to stay modest.
 */
function factorBlastRadius(metadata?: Record<string, unknown>): ScoreExplanation | null {
  const affected = metadata?.blastRadius;
  if (typeof affected !== 'number' || affected <= 0) return null;
  const delta = +(Math.min(affected / 20, 1) * 0.05).toFixed(3);
  if (delta < 0.005) return null;
  return {
    factor: 'blast-radius',
    delta,
    reason: `Blast radius: ${affected} affected symbol(s) — fault propagation risk`,
  };
}

/**
 * Factor 6 — Signal strength (structural penalty + anomaly bonus).
 *
 * Causes backed only by structural evidence (topology markers: symbol, flow,
 * impact, queue-edge) are penalized because they represent static code
 * structure, not runtime anomalies. High-relevance anomaly evidence earns
 * a small boost.
 */
function factorSignalStrength(items: Evidence[]): ScoreExplanation | null {
  const nonStructural = items.filter((e) => !STRUCTURAL_KINDS.has(e.kind));

  if (items.length > 0 && nonStructural.length === 0) {
    return {
      factor: 'signal-strength',
      delta: -0.05,
      reason: 'All evidence is structural (topology-only) — no runtime anomaly signal',
    };
  }

  const highRelevance = nonStructural.filter((e) => e.relevance >= 0.85);
  if (highRelevance.length > 0) {
    return {
      factor: 'signal-strength',
      delta: 0.03,
      reason: `${highRelevance.length} high-relevance anomaly signal(s) (relevance ≥ 0.85)`,
    };
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a single cause candidate by applying all six factors to its baseScore.
 * Returns a fully populated CauseCandidate with explanations for every
 * factor that fired.
 */
export function scoreCause(input: CauseInput, ctx: ScoringContext): CauseCandidate {
  const now = ctx.now ?? new Date().toISOString();

  const idSet = new Set(input.sourceEvidenceIds);
  const attached = ctx.evidence.filter((e) => idSet.has(e.id));

  const rawFactors = [
    factorEvidenceQuality(attached),
    factorSourceDiversity(attached),
    factorGraphProximity(input.sourceEvidenceIds, ctx.graph),
    factorRuntimeSignals(attached, now),
    factorBlastRadius(input.metadata),
    factorSignalStrength(attached),
  ];

  const explanations = rawFactors.filter((f): f is ScoreExplanation => f !== null);
  const totalDelta = explanations.reduce((sum, e) => sum + e.delta, 0);
  const finalScore = clamp01(input.baseScore + totalDelta);
  const band = getBand(finalScore);

  return {
    id: input.id,
    title: input.title,
    category: input.category,
    sourceEvidenceIds: input.sourceEvidenceIds,
    affectedNodeIds: input.affectedNodeIds ?? [],
    baseScore: input.baseScore,
    finalScore,
    confidence: finalScore,
    band,
    explanations,
    metadata: input.metadata,
  };
}

/**
 * Score and rank a set of cause inputs. Returns at most `limit` candidates
 * in descending finalScore order, with a deterministic id-based tiebreaker.
 */
export function rankCauses(
  inputs: CauseInput[],
  ctx: ScoringContext,
  limit = 3,
): CauseCandidate[] {
  const scored = inputs.map((i) => scoreCause(i, ctx));
  scored.sort((a, b) => {
    const d = b.finalScore - a.finalScore;
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  });
  return scored.slice(0, limit);
}
