/**
 * Evidence normalization layer (HOR-13).
 *
 * Providers emit raw Evidence with source/kind/relevance/payload set.
 * This layer adds the two cross-provider dimensions that the engine and
 * renderers use for grouping and prioritization:
 *
 *   • category — broad functional bucket (queue, database, logs, code, …)
 *   • priority — investigation-priority tier (critical → info); NOT operational severity
 *
 * Both fields are optional on the Evidence type so that provider code
 * compiles unchanged. Call normalizeEvidence() once after all providers
 * have returned, before findings derivation.
 */

import type { Evidence, EvidenceCategory, EvidencePriority } from '@horus/core';

// ── Category mapping ──────────────────────────────────────────────────────────

function categoryFor(e: Evidence): EvidenceCategory {
  // ProviderKind 'state' covers both MongoDB and Redis. Distinguish by kind
  // so redis-key evidence is not misclassified as database.
  if (e.kind === 'redis-key') return 'cache';
  switch (e.source) {
    case 'queue':
      return 'queue';
    case 'logs':
      return 'logs';
    case 'metrics':
      return 'metrics';
    case 'state':
      return 'database';
    case 'history':
      return 'deployment';
    case 'code':
      return 'code';
    default:
      return 'other';
  }
}

// ── Priority mapping ──────────────────────────────────────────────────────────

/**
 * Structural kinds are never anomalous by themselves — they provide context
 * for the AI to reason about, not signals that something is broken.
 */
const STRUCTURAL_KINDS = new Set(['symbol', 'flow', 'impact', 'queue-edge']);

function priorityFor(e: Evidence): EvidencePriority {
  if (STRUCTURAL_KINDS.has(e.kind)) return 'info';

  // Commits are structural unless a particularly relevant change is flagged.
  if (e.kind === 'commit') return e.relevance >= 0.8 ? 'medium' : 'info';

  // State snapshots (queue, DB, cache): low-relevance items represent healthy
  // or legacy state — context that enriches the picture, not evidence of a
  // broken system. Skip 'low' so the tier stays meaningful.
  if (e.kind === 'queue-state' || e.kind === 'state' || e.kind === 'redis-key') {
    if (e.relevance >= 0.9) return 'critical';
    if (e.relevance >= 0.8) return 'high';
    if (e.relevance >= 0.6) return 'medium';
    return 'info';
  }

  // Operational signals (log, metric, …): use the full relevance scale.
  if (e.relevance >= 0.9) return 'critical';
  if (e.relevance >= 0.8) return 'high';
  if (e.relevance >= 0.6) return 'medium';
  if (e.relevance >= 0.4) return 'low';
  return 'info';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fill in `priority` and `category` for every evidence item in-place.
 *
 * Idempotent: values already set by a previous call (or by a test/fixture)
 * are left unchanged. Returns the same array so callers can chain.
 */
export function normalizeEvidence(evidence: Evidence[]): Evidence[] {
  for (const e of evidence) {
    if (e.category === undefined) e.category = categoryFor(e);
    if (e.priority === undefined) e.priority = priorityFor(e);
  }
  return evidence;
}
