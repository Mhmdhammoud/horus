/**
 * HOR-15 review — report migration boundary.
 *
 * Persisted investigation reports may have been written before HOR-15
 * renamed SuspectedCause fields:
 *
 *   statement  → title
 *   score      → finalScore / confidence
 *   evidenceIds → sourceEvidenceIds
 *
 * migrateReport() normalises the old shape to CauseCandidate without
 * touching any other part of the report. The function is idempotent:
 * causes that already carry the new fields are passed through unchanged.
 */

import type { InvestigationReport } from './types.js';
import type { CauseBand } from './score-cause.js';

function getBand(score: number): CauseBand {
  if (score >= 0.85) return 'highly-likely';
  if (score >= 0.65) return 'likely';
  if (score >= 0.40) return 'possible';
  return 'observation';
}

/**
 * Accept a raw JSON blob from the audit store and return a fully typed
 * InvestigationReport. Legacy SuspectedCause entries are promoted to
 * CauseCandidate in-place; all other fields are preserved verbatim.
 *
 * Throws when `raw` is not an object (completely corrupt row).
 */
export function migrateReport(raw: unknown): InvestigationReport {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('migrateReport: expected an object, got ' + typeof raw);
  }
  const r = raw as Record<string, unknown>;

  if (Array.isArray(r['suspectedCauses'])) {
    r['suspectedCauses'] = (r['suspectedCauses'] as unknown[]).map(
      (c: unknown, i: number) => {
        if (c === null || typeof c !== 'object') return c;
        const cause = c as Record<string, unknown>;

        // Already in the new CauseCandidate shape — pass through.
        if (typeof cause['title'] === 'string' && typeof cause['finalScore'] === 'number') {
          return cause;
        }

        // Legacy SuspectedCause shape: { statement, score, evidenceIds }.
        const statement = typeof cause['statement'] === 'string' ? cause['statement'] : '';
        const score = typeof cause['score'] === 'number' ? cause['score'] : 0;
        const evidenceIds = Array.isArray(cause['evidenceIds']) ? cause['evidenceIds'] : [];

        return {
          id: `cause:legacy:${i}`,
          title: statement,
          category: 'unknown',
          sourceEvidenceIds: evidenceIds,
          affectedNodeIds: [],
          baseScore: score,
          finalScore: score,
          confidence: score,
          band: getBand(score),
          explanations: [],
          ...(cause['metadata'] !== undefined ? { metadata: cause['metadata'] } : {}),
        };
      },
    );
  }

  return r as unknown as InvestigationReport;
}
