/**
 * Evidence normalization layer (HOR-13).
 *
 * Providers emit raw Evidence with source/kind/relevance/payload set.
 * This layer adds the two cross-provider dimensions that the engine and
 * renderers use for grouping and prioritization:
 *
 *   • category — broad functional bucket (queue, database, logs, code, …)
 *   • severity — actionability tier (critical → info)
 *
 * Both fields are optional on the Evidence type so that provider code
 * compiles unchanged. Call normalizeEvidence() once after all providers
 * have returned, before findings derivation.
 */

import type { Evidence, EvidenceCategory, EvidenceSeverity } from '@horus/core';

// ── Category mapping ──────────────────────────────────────────────────────────

function categoryFor(e: Evidence): EvidenceCategory {
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

// ── Severity mapping ──────────────────────────────────────────────────────────

/**
 * Structural kinds are never anomalous by themselves — they provide context
 * for the AI to reason about, not signals that something is broken.
 */
const STRUCTURAL_KINDS = new Set(['symbol', 'flow', 'impact', 'queue-edge']);

function severityFor(e: Evidence): EvidenceSeverity {
  if (STRUCTURAL_KINDS.has(e.kind)) return 'info';

  // Commits are structural unless a particularly relevant change is flagged.
  if (e.kind === 'commit') return e.relevance >= 0.8 ? 'medium' : 'info';

  // All other kinds: use the relevance score as a proxy for signal strength.
  if (e.relevance >= 0.9) return 'critical';
  if (e.relevance >= 0.8) return 'high';
  if (e.relevance >= 0.6) return 'medium';
  if (e.relevance >= 0.4) return 'low';
  return 'info';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fill in `severity` and `category` for every evidence item in-place.
 *
 * Idempotent: values already set by a previous call (or by a test/fixture)
 * are left unchanged. Returns the same array so callers can chain.
 */
export function normalizeEvidence(evidence: Evidence[]): Evidence[] {
  for (const e of evidence) {
    if (e.category === undefined) e.category = categoryFor(e);
    if (e.severity === undefined) e.severity = severityFor(e);
  }
  return evidence;
}
