/**
 * Evidence normalization layer (HOR-13).
 *
 * Providers emit raw Evidence with source/kind/relevance/payload set.
 * This layer adds the two cross-provider dimensions that the engine and
 * renderers use for grouping and prioritization:
 *
 *   • category — broad functional bucket (queue, database, logs, code, …)
 *   • priority — investigation-priority tier (critical → info); NOT operational severity
 *   • subject  — the entity under investigation (service/environment), derived
 *                from connector config + investigation scope (Stage 0)
 *
 * All three fields are optional on the Evidence type so that provider code
 * compiles unchanged. Call normalizeEvidence() once after all providers
 * have returned, before findings derivation. The subject is the same discipline
 * as priority/category — it is assigned here, never by providers, and is inert
 * (left unset) when neither a service nor an environment is known.
 */

import type {
  Evidence,
  EvidenceCategory,
  EvidencePriority,
  EvidenceSubject,
} from '@horus/core';

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

// ── Subject mapping ─────────────────────────────────────────────────────────

/**
 * The investigation/connector scope used to stamp the subject onto evidence.
 * Built by the caller (engine) from connector config + investigation scope —
 * never derived from provider payloads.
 */
export interface NormalizeContext {
  service?: string;
  environment?: string;
}

/**
 * Build an EvidenceSubject from scope, or `undefined` when nothing is known.
 * Honesty: a field is present only when it has a real value; an all-empty
 * subject is never produced (stays inert rather than stamping `{}`).
 */
function subjectFrom(ctx: NormalizeContext | undefined): EvidenceSubject | undefined {
  if (ctx === undefined) return undefined;
  const subject: EvidenceSubject = {};
  if (ctx.service !== undefined && ctx.service !== '') subject.service = ctx.service;
  if (ctx.environment !== undefined && ctx.environment !== '') subject.environment = ctx.environment;
  return subject.service !== undefined || subject.environment !== undefined ? subject : undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fill in `priority`, `category`, and (when scope is known) `subject` for every
 * evidence item in-place.
 *
 * Idempotent: values already set by a previous call (or by a test/fixture)
 * are left unchanged. Returns the same array so callers can chain. The optional
 * `context` carries the investigation/connector scope; when it resolves to a
 * real service/environment the subject is stamped, otherwise it is left unset.
 */
export function normalizeEvidence(evidence: Evidence[], context?: NormalizeContext): Evidence[] {
  const subject = subjectFrom(context);
  for (const e of evidence) {
    if (e.category === undefined) e.category = categoryFor(e);
    if (e.priority === undefined) e.priority = priorityFor(e);
    if (e.subject === undefined && subject !== undefined) e.subject = { ...subject };
  }
  return evidence;
}
