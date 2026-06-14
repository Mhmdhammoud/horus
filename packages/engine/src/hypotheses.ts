/**
 * HOR-24 — Deterministic competing-hypothesis generation.
 *
 * Generates a fixed set of competing hypotheses so the investigation never
 * anchors on a single explanation. Hypotheses are always emitted (even
 * unsupported ones), with their missing evidence listed so the analyst knows
 * exactly what data would confirm or refute each candidate.
 *
 * Pure and synchronous; no I/O, no randomness beyond the UUID generator.
 */

import type { Evidence } from '@horus/core';
import type { CorrelationResult } from './correlate.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Hypothesis {
  id: string;
  category: string;
  statement: string;
  /** 0–1 prior confidence derived deterministically from available evidence. */
  confidence: number;
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
}

// ---------------------------------------------------------------------------
// Context supplied by the engine
// ---------------------------------------------------------------------------

export interface HypothesisContext {
  /** Human-readable label for the seed symbol (e.g. "OrderService"). */
  seedLabel: string;
  /** Distinct queue names that appear in the implicated queue-edge evidence. */
  queues: string[];
  /** Metric evidence IDs with latency-spike or error-rate-change anomalies (HOR-40). */
  latencyMetricEvIds?: string[];
  /** Metric evidence IDs with queue-growth anomalies (HOR-40). */
  queueMetricEvIds?: string[];
  /** queue-state evidence IDs with 'backlog' signal — high waiting-job counts (HOR-45). */
  queueBacklogEvIds?: string[];
  /** queue-state evidence IDs with 'worker-starvation' signal — 0 active workers (HOR-45). */
  queueStarvationEvIds?: string[];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate the full competing set of hypotheses.
 *
 * Deterministic: given the same evidence + correlation + ctx, the same
 * hypothesis *objects* are produced (modulo the UUID values which are
 * inherently non-deterministic but do not affect logical content).
 *
 * The returned array is sorted by confidence descending (stable sort).
 */
export function generateHypotheses(
  evidence: Evidence[],
  _correlation: CorrelationResult,
  ctx: HypothesisContext,
): Hypothesis[] {
  const commitEvs = evidence.filter((e) => e.kind === 'commit');
  const queueEvs = evidence.filter((e) => e.kind === 'queue-edge');
  const hasCommit = commitEvs.length > 0;
  const { queues } = ctx;

  const hyps: Hypothesis[] = [];

  // a. deployment-regression — always emitted
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'deployment-regression',
    statement:
      'A recent change/deployment touching ' + ctx.seedLabel + ' introduced the fault.',
    confidence: hasCommit ? 0.5 : 0.15,
    supportingEvidenceIds: commitEvs.map((e) => e.id),
    contradictingEvidenceIds: [],
    missingEvidence: hasCommit
      ? []
      : [
          'A change/deployment range — re-run with --since <ref> to diff what shipped',
        ],
  });

  // b. queue-backlog — only when queue evidence exists.
  // supportingEvidenceIds uses BullMQ queue-state 'backlog' signals only.
  // queue-edge evidence is structural (the code has a queue call) and does not
  // confirm a live backlog; runtime depth counts do.
  if (queueEvs.length > 0) {
    const queueBacklogEvIds = ctx.queueBacklogEvIds ?? [];
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'queue-backlog',
      statement:
        'A backlog on ' +
        queues.join(', ') +
        ' — producers enqueue faster than the worker drains.',
      confidence: queueBacklogEvIds.length > 0 ? 0.7 : 0.35,
      supportingEvidenceIds: [...queueBacklogEvIds],
      contradictingEvidenceIds: [],
      missingEvidence: queueBacklogEvIds.length > 0
        ? []
        : ['Live queue depth + failed/delayed counts (Redis/BullMQ — `horus queues`)'],
    });
  }

  // c. worker-slowdown — only when queue evidence exists.
  // Confirmed by: Grafana queue-growth metric anomalies OR BullMQ starvation
  // (waiting jobs, zero active workers). Structural queue-edge evidence only
  // shows the queue exists and cannot confirm worker slowness.
  if (queueEvs.length > 0) {
    const queueMetricEvIds = ctx.queueMetricEvIds ?? [];
    const queueStarvationEvIds = ctx.queueStarvationEvIds ?? [];
    const slowdownEvIds = [...queueMetricEvIds, ...queueStarvationEvIds];
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'worker-slowdown',
      statement:
        'The worker(s) consuming ' +
        queues.join(', ') +
        ' are processing slowly or stalling.',
      confidence: slowdownEvIds.length > 0 ? 0.55 : 0.3,
      supportingEvidenceIds: slowdownEvIds,
      contradictingEvidenceIds: [],
      missingEvidence: slowdownEvIds.length > 0
        ? []
        : ['Worker latency/throughput metrics (Grafana — `horus metrics`)'],
    });
  }

  // d. external-api-latency — always emitted
  const latencyMetricEvIds = ctx.latencyMetricEvIds ?? [];
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'external-api-latency',
    statement:
      'An upstream/external API the implicated code calls is slow or returning errors.',
    confidence: latencyMetricEvIds.length > 0 ? 0.55 : 0.2,
    supportingEvidenceIds: latencyMetricEvIds,
    contradictingEvidenceIds: [],
    missingEvidence: latencyMetricEvIds.length > 0
      ? []
      : ['Request latency metrics (Grafana) + error logs (Elasticsearch)'],
  });

  // e. retry-storm — always emitted
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'retry-storm',
    statement: 'A retry storm is amplifying load on the failing path.',
    confidence: 0.15,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [
      'Retry/error logs + queue retry statistics (Elasticsearch + BullMQ)',
    ],
  });

  // f. infrastructure — always emitted
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'infrastructure',
    statement:
      'An infrastructure issue (database, Redis, or network) is degrading processing.',
    confidence: 0.15,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: ['Infra/Redis metrics (Grafana) + Redis state'],
  });

  // Sort by confidence descending (stable — JS Array.sort is stable in V8 / Node 11+)
  hyps.sort((a, b) => b.confidence - a.confidence);

  return hyps;
}
