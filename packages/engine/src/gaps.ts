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
  redis?: boolean;
  /**
   * True when metrics collection ran to completion (even with zero anomalies).
   * False/absent + grafana:true means collection was attempted but failed.
   * Lets the gap detector distinguish "no anomalies" from "collection failed".
   */
  metricsCollected?: boolean;
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
): GapAnalysis {
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

  if (!hasLog) {
    gaps.push({
      dimension: 'logs',
      why: connectors.elasticsearch
        ? 'No error logs matched in the window — cannot confirm the actual error signatures.'
        : 'No Elasticsearch connector configured for this environment — no runtime logs.',
      nextSource: connectors.elasticsearch
        ? 'Widen the window (--since) or inspect `horus logs <service>`'
        : 'Add an `elasticsearch` connector to the project/environment',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot see the real error.');
  }

  // Only add a metrics gap when metrics are genuinely missing.
  // Successful collection with no anomalies is negative evidence — not a gap.
  if (!hasMetric && !(connectors.grafana && connectors.metricsCollected)) {
    const metricsWhy = !connectors.grafana
      ? 'No Grafana connector configured — cannot see latency/error-rate trends.'
      : 'Grafana metrics collection failed or timed out — metric trends unavailable for this investigation.';
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

  if (hasQueueTopology && !hasQueueState) {
    gaps.push({
      dimension: 'queue runtime state',
      why: connectors.redis
        ? 'Queue topology is known but live depth + failed/delayed counts were not collected.'
        : 'Queue topology is known but there is no Redis/BullMQ connector for live depth/failures.',
      nextSource: connectors.redis
        ? 'Inspect `horus queues`'
        : 'Add a `redis` connector to read live BullMQ state',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot determine if the queue is actually backed up.');
  }

  if (!hasCommit) {
    gaps.push({
      dimension: 'deployment records',
      why: 'No deployment/change data in scope — cannot tell what shipped before the incident.',
      nextSource: 'Re-run with --since <ref>, or `horus what-changed <service>`',
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

  if (!hasTrace) {
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
  const raw = 1 - totalImpact;
  const confidenceCeiling = Math.round(Math.max(0.3, raw) * 100) / 100;

  return { gaps, blindSpots, confidenceCeiling };
}
