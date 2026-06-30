/**
 * HOR-15 — Cause Scoring Engine v2.
 *
 * Replaces scattered heuristic scoring with principled, explainable
 * multi-factor scoring. Every boost/penalty produces a human-readable
 * explanation. Scores map to four confidence bands.
 */

import type { Evidence } from '@horus/core';
import type { InvestigationGraph } from './graph.js';
import { maxImplicationScore, implicatedNodeIds } from './graph.js';

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

/**
 * Minimal finding shape accepted by the scorer. Structurally compatible with
 * `ReportFinding` from types.ts (not imported to avoid a circular dependency
 * — score-cause.ts is imported by types.ts via CauseCandidate).
 */
export interface ScoringFinding {
  kind: string;
  confidence: number;
  evidenceIds: string[];
}

/**
 * Investigation request parameters forwarded to the scorer.
 * Used by the request-context factor to check whether the queried service
 * is directly implicated by a cause's evidence in the graph.
 */
export interface ScoringRequest {
  hint?: string;
  service?: string;
}

/** Contextual data the scorer uses to compute factor adjustments. */
export interface ScoringContext {
  /** Normalized evidence from the current investigation. */
  evidence: Evidence[];
  /** Infrastructure topology derived from evidence (HOR-14). */
  graph: InvestigationGraph;
  /**
   * Findings produced by the investigation engine. Used by the
   * finding-uncertainty factor to penalize causes whose evidence is only
   * referenced by low-confidence findings. Omit when calling the scorer
   * outside the engine.
   */
  findings?: ScoringFinding[];
  /**
   * Map of provider source ID → reliability score (0–1). Built by engine.ts
   * from the set of connected providers. When absent, Factor 8 is skipped.
   */
  providerReliability?: Record<string, number>;
  /**
   * Original investigation request. When present, Factor 9 checks whether
   * the queried service is directly implicated in the graph for this cause.
   */
  request?: ScoringRequest;
  /**
   * Reference timestamp for recency calculations. Defaults to now if omitted.
   * Inject a fixed value in tests to ensure determinism.
   */
  now?: string;
  /**
   * Incident memory (HOR-363): graph node id (`symbol:<name>` / `file:<path>`) → number of
   * PRIOR investigations that touched it. Built by the engine from the incident store. When
   * present, Factor 10 boosts a cause whose code has a prior-incident history. Omit to skip.
   */
  priorIncidents?: Map<string, number>;
  /**
   * HOR-385 (source-impact mode): when `'source-impact'`, the structural penalties that
   * exist to demote topology-only causes in an INCIDENT are dropped — they would wrongly
   * punish the blast-radius cause that IS the answer to "what depends on X". Specifically
   * factor-6 signal-strength (the −0.05 "all evidence is structural") and factor-7
   * finding-uncertainty are skipped, and the info-priority arm of factor-1 evidence-quality
   * (the −0.05) is suppressed. Default undefined ⇒ incident scoring is unchanged.
   */
  mode?: 'source-impact';
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

/**
 * Map a 0–1 score to a qualitative confidence band. Exported so the agent-packet
 * layer (packet.ts) can derive the report-level honesty band from `report.confidence`
 * using the exact same thresholds, avoiding drift (HOR-384).
 */
export function getBand(score: number): CauseBand {
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
function factorEvidenceQuality(
  items: Evidence[],
  suppressInfoPenalty = false,
): ScoreExplanation | null {
  const scored = items.filter(
    (ev) => ev.priority !== undefined && ev.priority !== 'info',
  );
  if (scored.length === 0) {
    if (items.length === 0) return null;
    // HOR-385: in source-impact mode "all evidence is info priority" is the EXPECTED shape of a
    // purely structural cause, not a signal weakness — don't penalise it.
    if (suppressInfoPenalty) return null;
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
    const rawAgeMs = nowMs - newestTs;
    // Future timestamps: within 5 min tolerance → treat as "just now";
    // further in the future → skip recency (cannot trust the timestamp).
    const ageMs = rawAgeMs < 0 ? (rawAgeMs >= -300_000 ? 0 : null) : rawAgeMs;
    if (ageMs !== null) {
      if (ageMs <= 3_600_000) {           // ≤ 1 hour
        recencyDelta = 0.05;
        recencyReason = 'Evidence from within the last hour';
      } else if (ageMs <= 86_400_000) {   // ≤ 24 hours
        recencyDelta = 0.02;
        recencyReason = 'Evidence from within the last 24 hours';
      } else if (ageMs <= 259_200_000) {  // 24 h – 3 days: neutral
        // no contribution either way
      } else if (ageMs <= 604_800_000) {  // 3 – 7 days: stale
        recencyDelta = -0.02;
        recencyReason = 'Most recent evidence is 3–7 days old — may predate this incident';
      } else {                            // > 7 days: very stale
        recencyDelta = -0.05;
        recencyReason = 'Most recent evidence is over 7 days old — likely predates this incident';
      }
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
  if (Math.abs(delta) < 0.001) return null;

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

/**
 * Factor 7 — Finding uncertainty.
 *
 * Engine findings are deterministic interpretations of the same evidence IDs,
 * not independent observations. This factor therefore never boosts a score
 * (doing so would double-count one signal). Instead it penalises causes whose
 * evidence only appears in low-confidence findings: if the investigation itself
 * is not confident about what the evidence means, the cause should not score
 * too high either.
 *
 * - No relevant findings, or max finding confidence ≥ 0.60 → 0 (neutral)
 * - All relevant findings below 0.60 → negative delta proportional to the gap:
 *     delta = −(0.60 − maxConfidence) × 0.10   (max −0.06)
 */
function factorFindingUncertainty(
  sourceEvidenceIds: string[],
  findings: ScoringFinding[],
): ScoreExplanation | null {
  if (findings.length === 0) return null;
  const idSet = new Set(sourceEvidenceIds);
  const relevant = findings.filter(
    (f) => f.kind !== 'observation' && f.evidenceIds.some((eid) => idSet.has(eid)),
  );
  if (relevant.length === 0) return null;
  const maxConfidence = Math.max(...relevant.map((f) => f.confidence));
  if (maxConfidence >= 0.60) return null; // investigation is confident — neutral
  const delta = +( -(0.60 - maxConfidence) * 0.10 ).toFixed(3);
  if (delta === 0) return null;
  return {
    factor: 'finding-uncertainty',
    delta,
    reason: `Relevant findings have low confidence (max ${maxConfidence.toFixed(2)}) — investigation uncertain about evidence significance`,
  };
}

/**
 * Factor 8 — Provider reliability.
 *
 * Different evidence providers have different intrinsic reliability. A code
 * provider emitting structured static-analysis evidence is more reliable than
 * a log-scraping pipeline that may have gaps or noise. This factor reads
 * `ScoringContext.providerReliability` (a caller-supplied map of source ID →
 * 0–1 score) and adjusts based on the average reliability of the sources
 * behind the cause's evidence.
 *
 * - avg ≥ 0.80 → +0.03 (high-reliability evidence base)
 * - avg < 0.50 → −0.03 (low-reliability evidence base)
 * - 0.50 ≤ avg < 0.80 → null (neutral; no reason to adjust)
 * - `ctx.providerReliability` absent → null (factor skipped)
 */
function factorProviderReliability(
  items: Evidence[],
  reliability: Record<string, number>,
): ScoreExplanation | null {
  if (items.length === 0) return null;
  const sources = [...new Set(items.map((e) => e.source))];
  const scores = sources.map((s) => reliability[s] ?? 0.65);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg >= 0.80) {
    return {
      factor: 'provider-reliability',
      delta: 0.03,
      reason: `Evidence from high-reliability provider(s) (avg reliability ${avg.toFixed(2)})`,
    };
  }
  if (avg < 0.50) {
    return {
      factor: 'provider-reliability',
      delta: -0.03,
      reason: `Evidence from low-reliability provider(s) (avg reliability ${avg.toFixed(2)})`,
    };
  }
  return null;
}

/**
 * Factor 9 — Request / implicated-path context.
 *
 * When the investigation was scoped to a specific service, we check whether
 * that service appears as an **implicated** `service`-type node in the graph
 * whose evidenceIds overlap with this cause's sourceEvidenceIds.
 *
 * This is complementary to graph-proximity (which measures implication
 * strength for any node): request-context rewards causes that land on the
 * exact service the operator was investigating, not just any implicated node.
 *
 * No boost when `ctx.request.service` is absent (hint-only queries are too
 * loose for deterministic matching at this layer).
 */
function factorRequestContext(
  sourceEvidenceIds: string[],
  graph: InvestigationGraph,
  request: ScoringRequest,
): ScoreExplanation | null {
  if (!request.service) return null;
  const serviceNodeId = `service:${request.service}`;
  const idSet = new Set(sourceEvidenceIds);
  const matched = graph.nodes.some(
    (n) =>
      n.id === serviceNodeId &&
      n.implicated &&
      n.evidenceIds.some((eid) => idSet.has(eid)),
  );
  if (!matched) return null;
  return {
    factor: 'request-context',
    delta: 0.04,
    reason: `Cause directly implicates the investigated service (${request.service})`,
  };
}

/**
 * Factor 10 — Incident memory.
 *
 * Horus persists every investigation. When a candidate cause's code (the symbol/file graph
 * nodes touching its evidence) was also touched by PRIOR investigations, that history is
 * corroborating signal — this area has been investigated before. `ctx.priorIncidents` maps
 * graph node id → prior-investigation count (built by the engine from the incident store).
 *
 * NOTE: symbol/file nodes are never marked `implicated` (that flag is infra-only), so this
 * matches on code nodes attached to the cause's evidence, not `implicatedNodeIds`.
 *
 * Bounded to +0.10 so history can never manufacture a confident headline on thin current
 * evidence — the confidence ceiling still governs the result.
 */
function factorIncidentHistory(
  sourceEvidenceIds: string[],
  graph: InvestigationGraph,
  priorIncidents: Map<string, number>,
): ScoreExplanation | null {
  if (priorIncidents.size === 0) return null;
  const idSet = new Set(sourceEvidenceIds);
  const codeNodes = graph.nodes.filter(
    (n) =>
      (n.type === 'symbol' || n.type === 'file') &&
      n.evidenceIds.some((eid) => idSet.has(eid)),
  );
  const matched: typeof codeNodes = [];
  let totalPrior = 0;
  for (const n of codeNodes) {
    const count = priorIncidents.get(n.id);
    if (count && count > 0) {
      matched.push(n);
      totalPrior += count;
    }
  }
  if (matched.length === 0) return null;
  // +0.04 per distinct matched code node, capped at +0.10.
  const delta = +Math.min(matched.length * 0.04, 0.1).toFixed(3);
  const names = matched.slice(0, 3).map((n) => n.label);
  return {
    factor: 'incident-history',
    delta,
    reason: `Implicated code has a prior-incident history (${totalPrior} prior investigation(s) on ${names.join(', ')}${matched.length > 3 ? ', …' : ''})`,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a single cause candidate by applying all ten factors to its baseScore:
 * evidence-quality, source-diversity, graph-proximity, runtime-signals, blast-radius,
 * signal-strength, finding-uncertainty, provider-reliability, request-context, and
 * incident-history (the last four are conditional on context). Returns a fully populated
 * CauseCandidate with explanations for every factor that fired.
 */
export function scoreCause(input: CauseInput, ctx: ScoringContext): CauseCandidate {
  const now = ctx.now ?? new Date().toISOString();

  const idSet = new Set(input.sourceEvidenceIds);
  const attached = ctx.evidence.filter((e) => idSet.has(e.id));

  const sourceImpact = ctx.mode === 'source-impact';
  const rawFactors = [
    factorEvidenceQuality(attached, sourceImpact),
    factorSourceDiversity(attached),
    factorGraphProximity(input.sourceEvidenceIds, ctx.graph),
    factorRuntimeSignals(attached, now),
    factorBlastRadius(input.metadata),
    // HOR-385: drop the structural-only penalty (factor 6) and finding-uncertainty (factor 7)
    // for a source-impact cause — the blast-radius cause IS the answer, not a weak topology guess.
    sourceImpact ? null : factorSignalStrength(attached),
    sourceImpact ? null : factorFindingUncertainty(input.sourceEvidenceIds, ctx.findings ?? []),
    ctx.providerReliability ? factorProviderReliability(attached, ctx.providerReliability) : null,
    ctx.request ? factorRequestContext(input.sourceEvidenceIds, ctx.graph, ctx.request) : null,
    ctx.priorIncidents
      ? factorIncidentHistory(input.sourceEvidenceIds, ctx.graph, ctx.priorIncidents)
      : null,
  ];

  const explanations = rawFactors.filter((f): f is ScoreExplanation => f !== null);
  const totalDelta = explanations.reduce((sum, e) => sum + e.delta, 0);
  let rawScore = clamp01(input.baseScore + totalDelta);

  // Single-source ceiling: the `highly-likely` band (≥ 0.85) is documented as
  // requiring strong multi-source confirmation. A single provider can accumulate
  // many factor boosts from different angles of the same signal, so we hard-cap
  // single-source candidates at 0.84 regardless of factor totals.
  const distinctSources = new Set(attached.map((e) => e.source)).size;
  if (distinctSources <= 1 && rawScore > 0.84) {
    const ceilingDelta = +(0.84 - rawScore).toFixed(3);
    explanations.push({
      factor: 'single-source-ceiling',
      delta: ceilingDelta,
      reason: 'Highly-likely requires multi-source corroboration — capped at 0.84 (single provider)',
    });
    rawScore = 0.84;
  }

  const finalScore = rawScore;
  const band = getBand(finalScore);

  // Derive affectedNodeIds from the graph rather than relying on callers to
  // supply them: any implicated infrastructure node whose evidence overlaps
  // with this cause's sourceEvidenceIds is considered affected.
  const derivedNodeIds =
    input.affectedNodeIds ?? implicatedNodeIds(ctx.graph, input.sourceEvidenceIds);

  return {
    id: input.id,
    title: input.title,
    category: input.category,
    sourceEvidenceIds: input.sourceEvidenceIds,
    affectedNodeIds: derivedNodeIds,
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

/**
 * SCORE-BASED headline selection (HOR-402 substage-1a, reorder-safe).
 *
 * Picks the headline cause — and whether it is structurally linked to the seed — by finalScore
 * ARGMAX rather than ARRAY POSITION, so the downstream confidence value and the "unlinked headline"
 * cap stay correct regardless of the order `rankCauses` (or any future reorder) hands the causes
 * back in. This is behavior-preserving today: rankCauses already sorts by finalScore desc, so the
 * argmax IS element [0]. Ties keep the FIRST occurrence in the given order (strict `>` comparison),
 * matching the previous `[0]` / `.find()` semantics on equal scores.
 *
 *   - topCause:       highest-finalScore cause overall.
 *   - topLinkedCause: highest-finalScore cause that clears the ≥0.2 bar AND is seed-linked.
 *   - headlineCause:  the linked one if any; else the top cause iff it clears ≥0.2 (HOR-340/336).
 *   - headlineLinked: whether the chosen headline is itself seed-linked.
 */
export function selectHeadlineCause(
  rankedCauses: readonly CauseCandidate[],
  isLinkedToSeed: (sourceEvidenceIds: string[]) => boolean,
  rerank?: (causes: readonly CauseCandidate[]) => CauseCandidate[],
): {
  topCause: CauseCandidate | undefined;
  topLinkedCause: CauseCandidate | undefined;
  headlineCause: CauseCandidate | undefined;
  headlineLinked: boolean;
} {
  // `topCause` stays the finalScore ARGMAX — it drives the downstream confidence ceiling and the
  // unlinked fallback, and must NEVER be influenced by the reranker (HOR-404 honesty bound: the
  // reranker may change WHICH eligible cause headlines, never the ceiling derived from the strongest
  // available cause, and never any score).
  let topCause: CauseCandidate | undefined;
  for (const c of rankedCauses) {
    if (topCause === undefined || c.finalScore > topCause.finalScore) topCause = c;
  }

  // Pick the headline among an ALREADY-ELIGIBLE set: with a reranker, by learned order; without one,
  // by finalScore argmax (behavior-identical to the pre-HOR-404 engine). The reranker only REORDERS
  // the eligible candidates — it can never promote a cause that failed the ≥0.2 / seed-linked gates
  // applied below, and `includes` rejects any candidate it did not receive.
  const pickEligible = (set: CauseCandidate[]): CauseCandidate | undefined => {
    if (set.length === 0) return undefined;
    if (rerank) {
      const top = rerank(set).find((c) => set.includes(c));
      if (top) return top;
    }
    let best = set[0]!;
    for (const c of set) if (c.finalScore > best.finalScore) best = c;
    return best;
  };

  const linkedEligible = rankedCauses.filter(
    (c) => c.finalScore >= 0.2 && isLinkedToSeed(c.sourceEvidenceIds),
  );
  const allEligible = rankedCauses.filter((c) => c.finalScore >= 0.2);

  const topLinkedCause = pickEligible(linkedEligible);
  const headlineCause = topLinkedCause ?? pickEligible(allEligible);
  const headlineLinked =
    headlineCause !== undefined && isLinkedToSeed(headlineCause.sourceEvidenceIds);
  return { topCause, topLinkedCause, headlineCause, headlineLinked };
}
