/**
 * HOR-19 — Missing-evidence detector.
 *
 * Identifies what Horus does NOT know for a given investigation, why each gap
 * matters, where to obtain the missing data, and the deterministic confidence
 * impact. The resulting `GapAnalysis` caps `report.confidence` in engine.ts.
 */

import type { InvestigationReport } from './types.js';

/** Which connectors are configured for the active project/environment. */
export interface ConnectorFlags {
  elasticsearch?: boolean;
  grafana?: boolean;
  mongodb?: boolean;
  postgres?: boolean;
  /**
   * True when a Sentry error-tracking connector is configured for the env. Sentry is an
   * error source like Elasticsearch (its evidence is `kind: 'log'`), so a configured
   * Sentry that returns issues clears the logs gap. A configured-but-empty Sentry is
   * negative evidence, not a gap.
   */
  sentry?: boolean;
  redis?: boolean;
  /**
   * True when a BullMQ/queues runtime connector is configured for the env — i.e. a
   * Redis DB with role `bullmq`/`queues` (or the single legacy DB) is wired up, the
   * same condition under which `horus queues --live` can read live state (HOR-205).
   * Distinguishes "queue connector not configured" from "configured but no live
   * queue evidence" so source status / caveats don't claim queues are unconfigured
   * when they are readable.
   */
  queue?: boolean;
  /**
   * True when log collection ran to completion (even with zero signatures).
   * False/absent + elasticsearch:true means collection failed or was blocked.
   * Lets the gap detector distinguish "no matching logs" from "collection failed".
   */
  logsCollected?: boolean;
  /**
   * Set when collection was blocked by a field-mapping incompatibility.
   * Short human-readable summary of the error(s). Takes precedence over the
   * generic "collection failed" gap text.
   */
  logsCompatibilityError?: string;
  /**
   * True when Sentry error collection ran to completion (even with zero issues).
   * False/absent + sentry:true means collection was attempted but failed. Lets the gap
   * detector distinguish "no open issues" (negative evidence) from "collection failed".
   */
  sentryCollected?: boolean;
  /**
   * True when metrics collection ran to completion (even with zero anomalies).
   * False/absent + grafana:true means collection was attempted but failed.
   * Lets the gap detector distinguish "no anomalies" from "collection failed".
   */
  metricsCollected?: boolean;
  /**
   * Short description of why metrics collection failed (e.g. "metrics timeout",
   * "connection refused"). Only set when collection was attempted and failed.
   * Used to surface the exact failure reason in the gap analysis.
   */
  metricsFailureReason?: string;
  /**
   * True when the user already supplied a `--since` value.
   * Changes the "deployment records" gap text to avoid redundant "re-run with --since" advice.
   */
  sinceProvided?: boolean;
}

/** A single dimension of missing evidence and its investigation impact. */
export interface EvidenceGap {
  /** Short label for the missing dimension, e.g. 'logs'. */
  dimension: string;
  /** Context-aware sentence explaining why this gap matters for THIS investigation. */
  why: string;
  /** Where / how to obtain the missing data. */
  nextSource: string;
  /** How much this gap shaves off the confidence ceiling (0–1). */
  confidenceImpact: number;
}

/** Structured output of the missing-evidence analysis. */
export interface GapAnalysis {
  gaps: EvidenceGap[];
  /** One human sentence per gap, describing what cannot be determined. */
  blindSpots: string[];
  /**
   * The maximum confidence the investigation can claim given the gaps.
   * = Math.max(0.3, 1 − Σ confidenceImpact), rounded to 2 dp.
   */
  confidenceCeiling: number;
}

/**
 * Analyse `r` to find missing evidence dimensions and compute the confidence
 * ceiling. Purely deterministic — same report always produces the same result.
 */
export function detectMissingEvidence(
  r: InvestigationReport,
  connectors: ConnectorFlags = {},
  /**
   * HOR-385: when `'source-impact'`, runtime evidence is irrelevant to the structural
   * question ("what depends on X / is X isolated"), so the runtime gaps (logs, metrics,
   * queue-state, deployment, traces) are NOT pushed and the confidence ceiling is forced
   * to 1.0 — a complete structural answer is not "missing" runtime data. Ownership (a
   * structural gap) is still surfaced for display. Default undefined ⇒ incident path
   * unchanged.
   */
  mode?: 'source-impact',
): GapAnalysis {
  const sourceImpact = mode === 'source-impact';
  // ── Presence flags ──────────────────────────────────────────────────────────
  const hasLog = r.evidence.some((e) => e.kind === 'log');
  const hasMetric = r.evidence.some((e) => e.kind === 'metric');
  const hasQueueState = r.evidence.some((e) => e.kind === 'queue-state');
  const hasCommit = r.evidence.some((e) => e.kind === 'commit');
  const hasTrace = r.evidence.some((e) => e.links != null && e.links.traceId != null);
  const hasQueueTopology = r.timeline.boundaryCrossings.length > 0;
  const ownershipKnown = r.ownership != null && r.ownership.likelyMaintainer != null;

  const gaps: EvidenceGap[] = [];
  const blindSpots: string[] = [];

  // ── Candidate gaps — text reflects what's actually CONFIGURED, not tickets ──

  if (!hasLog && !sourceImpact) {
    let logWhy: string;
    let logNextSource: string;
    // Sentry is a second ERROR source (its evidence is also `kind: 'log'`). Treat the
    // "no runtime error evidence" gap as cleared/explained by EITHER source.
    if (!connectors.elasticsearch && !connectors.sentry) {
      logWhy = 'No Elasticsearch connector (nor Sentry) configured for this environment — no runtime error evidence.';
      logNextSource = 'Add an `elasticsearch` and/or `sentry` connector to the project/environment';
    } else if (!connectors.elasticsearch && connectors.sentry) {
      // ES absent but Sentry configured — the gap is purely about Sentry.
      logWhy = connectors.sentryCollected
        ? 'No open Sentry issues matched in the window — cannot confirm the actual error signatures.'
        : 'Sentry collection failed or timed out — cannot confirm the actual error signatures.';
      logNextSource = connectors.sentryCollected
        ? 'Widen the window (--since) or check the Sentry project for open issues'
        : 'Check the Sentry auth token / project, then retry';
    } else if (connectors.logsCompatibilityError) {
      logWhy =
        `Elasticsearch field mapping is incompatible with the index — log collection was blocked. ` +
        connectors.logsCompatibilityError;
      logNextSource =
        'Fix fields.* overrides in your connector config or choose the correct preset (meritt / ecs)';
    } else if (!connectors.logsCollected) {
      logWhy =
        'Log collection failed or timed out — cannot confirm the actual error signatures.';
      logNextSource =
        'Check Elasticsearch connectivity, then run `horus logs <service>` manually';
    } else {
      logWhy = 'No error logs matched in the window — cannot confirm the actual error signatures.';
      logNextSource = 'Widen the window (--since) or inspect `horus logs <service>`';
    }
    gaps.push({
      dimension: 'logs',
      why: logWhy,
      nextSource: logNextSource,
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot see the real error.');
  }

  // Only add a metrics gap when metrics are genuinely missing.
  // Successful collection with no anomalies is negative evidence — not a gap.
  if (!hasMetric && !(connectors.grafana && connectors.metricsCollected) && !sourceImpact) {
    const failureDetail = connectors.metricsFailureReason
      ? ` (${connectors.metricsFailureReason})`
      : '';
    const metricsWhy = !connectors.grafana
      ? 'No Grafana connector configured — cannot see latency/error-rate trends.'
      : `Grafana metrics collection failed or timed out${failureDetail} — metric trends unavailable for this investigation.`;
    const metricsNextSource = !connectors.grafana
      ? 'Add a `grafana` connector to the environment'
      : 'Check Grafana connectivity, then run `horus metrics "<hint>"` manually';
    gaps.push({
      dimension: 'metrics',
      why: metricsWhy,
      nextSource: metricsNextSource,
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot validate latency-based hypotheses.');
  }

  if (hasQueueTopology && !hasQueueState && !sourceImpact) {
    gaps.push({
      dimension: 'queue runtime state',
      why: connectors.redis
        ? 'Queue topology is known but live depth + failed/delayed counts were not collected.'
        : 'Queue topology is known but there is no Redis/BullMQ connector for live depth/failures.',
      nextSource: connectors.redis
        ? 'Run `horus queues --live` to see real-time queue depths and failed-job counts'
        : 'Add a `redis` connector to read live BullMQ state',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot determine if the queue is actually backed up.');
  }

  if (!hasCommit && !sourceImpact) {
    gaps.push({
      dimension: 'deployment records',
      why: connectors.sinceProvided
        ? 'No git changes found in the specified range — the ref may not be diffable or no commits fall in this window.'
        : 'No deployment/change data in scope — cannot tell what shipped before the incident.',
      nextSource: connectors.sinceProvided
        ? 'Use HEAD~N or a specific SHA/branch for git diff ranges (e.g. --since HEAD~5)'
        : 'Re-run with --since <ref>, or `horus what-changed <service>`',
      confidenceImpact: 0.08,
    });
    blindSpots.push('Cannot correlate with a recent change.');
  }

  if (!ownershipKnown) {
    gaps.push({
      dimension: 'ownership',
      why: 'The owning team/maintainer of the implicated component is unknown.',
      nextSource: '`horus owner <symbol>` (git history)',
      confidenceImpact: 0.05,
    });
    blindSpots.push('Cannot route to an owner.');
  }

  if (!hasTrace && !sourceImpact) {
    gaps.push({
      dimension: 'traces',
      why: 'No distributed traces — cannot follow a single request across the async queue boundary.',
      nextSource: 'Tracing instrumentation',
      confidenceImpact: 0.07,
    });
    blindSpots.push('Cannot trace the request end-to-end.');
  }

  // ── Confidence ceiling ───────────────────────────────────────────────────────
  let totalImpact = 0;
  for (const gap of gaps) {
    totalImpact += gap.confidenceImpact;
  }
  // HOR-385: a structural source-impact answer is complete — runtime gaps don't cap it.
  const raw = sourceImpact ? 1 : 1 - totalImpact;
  const confidenceCeiling = Math.round(Math.max(0.3, raw) * 100) / 100;

  return { gaps, blindSpots, confidenceCeiling };
}

/**
 * Converts gap `nextSource` hints into recommended next-action strings, sorted
 * by confidence impact (highest first). Safe to append directly to
 * `report.nextActions` — the strings are already action-phrased.
 */
export function gapNextActions(gaps: EvidenceGap[]): string[] {
  return [...gaps]
    .sort((a, b) => b.confidenceImpact - a.confidenceImpact)
    .map((g) => g.nextSource);
}
