/**
 * HOR-25 — Deterministic hypothesis validation.
 *
 * For every generated hypothesis, intersects its supporting/contradicting
 * evidence id sets with the evidence actually present and adjusts confidence
 * and verdict accordingly. Pure and synchronous; no I/O, no randomness.
 */

import type { Evidence } from '@horus/core';
import type { Hypothesis } from './hypotheses.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Verdict = 'supported' | 'unconfirmed' | 'weakened' | 'eliminated';

export interface ValidatedHypothesis extends Hypothesis {
  verdict: Verdict;
  /** Confidence value before validation adjustment. */
  priorConfidence: number;
  /** Number of supporting evidence ids that are present in the evidence set. */
  supportingPresent: number;
  /** Number of contradicting evidence ids that are present in the evidence set. */
  contradictingPresent: number;
  /** Human-readable sentence explaining the verdict. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Validate a set of hypotheses against the available evidence.
 *
 * Deterministic: same inputs → same outputs every time.
 * Sorting: by adjusted confidence descending, with 'eliminated' verdicts
 * always pushed to the end regardless of confidence.
 */
export function validateHypotheses(
  hyps: Hypothesis[],
  evidence: Evidence[],
): ValidatedHypothesis[] {
  const present = new Set(evidence.map((e) => e.id));

  const validated: ValidatedHypothesis[] = hyps.map((h) => {
    const supportingPresent = h.supportingEvidenceIds.filter((id) =>
      present.has(id),
    ).length;
    const contradictingPresent = h.contradictingEvidenceIds.filter((id) =>
      present.has(id),
    ).length;

    const confidence = clamp01(
      h.confidence + 0.15 * supportingPresent - 0.3 * contradictingPresent,
    );

    let verdict: Verdict;
    if (contradictingPresent > 0 && confidence < 0.1) {
      verdict = 'eliminated';
    } else if (contradictingPresent > 0) {
      verdict = 'weakened';
    } else if (supportingPresent > 0) {
      verdict = 'supported';
    } else {
      verdict = 'unconfirmed';
    }

    const firstMissing = h.missingEvidence[0];
    const awaitingClause =
      verdict === 'unconfirmed' && firstMissing !== undefined
        ? '; awaiting ' + firstMissing
        : '';

    const rationale =
      supportingPresent +
      ' supporting / ' +
      contradictingPresent +
      ' contradicting evidence present' +
      awaitingClause +
      '.';

    return {
      ...h,
      confidence,
      priorConfidence: h.confidence,
      verdict,
      supportingPresent,
      contradictingPresent,
      rationale,
    };
  });

  // Sort: by confidence desc, BUT push 'eliminated' verdicts to the end.
  validated.sort((a, b) => {
    const aElim = a.verdict === 'eliminated' ? 1 : 0;
    const bElim = b.verdict === 'eliminated' ? 1 : 0;
    if (aElim !== bElim) return aElim - bElim;
    return b.confidence - a.confidence;
  });

  return validated;
}
