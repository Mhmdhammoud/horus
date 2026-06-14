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

  // b. queue-backlog — only when queue evidence exists
  if (queueEvs.length > 0) {
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'queue-backlog',
      statement:
        'A backlog on ' +
        queues.join(', ') +
        ' — producers enqueue faster than the worker drains.',
      confidence: 0.35,
      supportingEvidenceIds: queueEvs.map((e) => e.id),
      contradictingEvidenceIds: [],
      missingEvidence: [
        'Live queue depth + failed/delayed job counts (BullMQ provider, HOR-12)',
      ],
    });
  }

  // c. worker-slowdown — only when queue evidence exists
  if (queueEvs.length > 0) {
    hyps.push({
      id: globalThis.crypto.randomUUID(),
      category: 'worker-slowdown',
      statement:
        'The worker(s) consuming ' +
        queues.join(', ') +
        ' are processing slowly or stalling.',
      confidence: 0.3,
      supportingEvidenceIds: queueEvs.map((e) => e.id),
      contradictingEvidenceIds: [],
      missingEvidence: [
        'Worker processing latency/throughput metrics (Prometheus, HOR-11)',
      ],
    });
  }

  // d. external-api-latency — always emitted
  hyps.push({
    id: globalThis.crypto.randomUUID(),
    category: 'external-api-latency',
    statement:
      'An upstream/external API the implicated code calls is slow or returning errors.',
    confidence: 0.2,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [
      'Request latency metrics + error logs (Prometheus/Elasticsearch, HOR-10/11)',
    ],
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
    missingEvidence: ['Infra/Redis metrics + Redis state (Prometheus/Redis)'],
  });

  // Sort by confidence descending (stable — JS Array.sort is stable in V8 / Node 11+)
  hyps.sort((a, b) => b.confidence - a.confidence);

  return hyps;
}
