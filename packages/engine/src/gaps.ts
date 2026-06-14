/**
 * HOR-19 — Missing-evidence detector.
 *
 * Identifies what Horus does NOT know for a given investigation, why each gap
 * matters, where to obtain the missing data, and the deterministic confidence
 * impact. The resulting `GapAnalysis` caps `report.confidence` in engine.ts.
 */

import type { InvestigationReport } from './types.js';

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
export function detectMissingEvidence(r: InvestigationReport): GapAnalysis {
  // ── Presence flags ──────────────────────────────────────────────────────────
  const hasLog = r.evidence.some((e) => e.kind === 'log');
  const hasMetric = r.evidence.some((e) => e.kind === 'metric');
  const hasQueueState = r.evidence.some((e) => e.kind === 'queue-state');
  const hasCommit = r.evidence.some((e) => e.kind === 'commit');
  const hasTrace = r.evidence.some((e) => e.links != null && e.links.traceId != null);
  const hasQueueTopology = r.timeline.boundaryCrossings.length > 0;
  // No ownership evidence kind yet — HOR-20.
  const ownershipKnown = false;

  const gaps: EvidenceGap[] = [];
  const blindSpots: string[] = [];

  // ── Candidate gaps (context-aware; only pushed when MISSING) ────────────────

  if (!hasLog) {
    gaps.push({
      dimension: 'logs',
      why: 'No runtime logs — cannot confirm the actual error signatures / what failed at runtime.',
      nextSource: 'Elasticsearch logs provider (HOR-10)',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot see the real error.');
  }

  if (!hasMetric) {
    const why = hasQueueTopology
      ? 'Queue boundaries are present but worker latency/throughput metrics are unavailable — cannot confirm the worker-slowdown or external-api-latency hypotheses.'
      : 'No metrics — cannot see latency/error-rate trends.';
    gaps.push({
      dimension: 'metrics',
      why,
      nextSource: 'Prometheus provider (HOR-11)',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot validate latency-based hypotheses.');
  }

  if (hasQueueTopology && !hasQueueState) {
    gaps.push({
      dimension: 'queue runtime state',
      why: 'Queue topology is known but live depth + failed/delayed job counts are unavailable — cannot confirm whether a backlog actually exists.',
      nextSource: 'BullMQ runtime provider (HOR-12) / horus queues',
      confidenceImpact: 0.1,
    });
    blindSpots.push('Cannot determine if the queue is actually backed up.');
  }

  if (!hasCommit) {
    gaps.push({
      dimension: 'deployment records',
      why: 'No deployment/change data in scope — cannot tell what shipped before the incident.',
      nextSource: 'Re-run with --since <ref>, or horus what-changed <service>',
      confidenceImpact: 0.08,
    });
    blindSpots.push('Cannot correlate with a recent change.');
  }

  if (!ownershipKnown) {
    gaps.push({
      dimension: 'ownership',
      why: 'The owning team/maintainer of the implicated component is unknown.',
      nextSource: 'Ownership mapping (HOR-20) / git blame',
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
