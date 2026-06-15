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

  // Normalize nextActions — required since v0.1 but absent in pre-v0.1 packets.
  if (!Array.isArray(r['nextActions'])) {
    r['nextActions'] = [];
  }

  if (Array.isArray(r['suspectedCauses'])) {
    r['suspectedCauses'] = (r['suspectedCauses'] as unknown[]).flatMap(
      (c: unknown, i: number) => {
        // Null or non-object entries cannot be migrated and would crash renderers;
        // drop them rather than propagating a shape that typed consumers can't handle.
        if (c === null || typeof c !== 'object') return [];
        const cause = c as Record<string, unknown>;

        // Current CauseCandidate shape (has title + finalScore).
        // Fill safe defaults for any missing required fields so renderers cannot
        // crash dereferencing undefined arrays (e.g. sourceEvidenceIds.some(...)).
        if (typeof cause['title'] === 'string' && typeof cause['finalScore'] === 'number') {
          const fs = cause['finalScore'] as number;
          return [{
            id: typeof cause['id'] === 'string' ? cause['id'] : `cause:partial:${i}`,
            title: cause['title'],
            category: typeof cause['category'] === 'string' ? cause['category'] : 'unknown',
            sourceEvidenceIds: Array.isArray(cause['sourceEvidenceIds']) ? cause['sourceEvidenceIds'] : [],
            affectedNodeIds: Array.isArray(cause['affectedNodeIds']) ? cause['affectedNodeIds'] : [],
            baseScore: typeof cause['baseScore'] === 'number' ? cause['baseScore'] : fs,
            finalScore: fs,
            confidence: typeof cause['confidence'] === 'number' ? cause['confidence'] : fs,
            band: typeof cause['band'] === 'string' ? cause['band'] : getBand(fs),
            explanations: Array.isArray(cause['explanations']) ? cause['explanations'] : [],
            ...(cause['metadata'] !== undefined ? { metadata: cause['metadata'] } : {}),
          }];
        }

        // Legacy SuspectedCause shape: { statement, score, evidenceIds }.
        // Drop entries with no statement — they carry no diagnostic value.
        const statement = typeof cause['statement'] === 'string' ? cause['statement'] : '';
        if (!statement) return [];

        const score = typeof cause['score'] === 'number' ? cause['score'] : 0;
        const evidenceIds = Array.isArray(cause['evidenceIds']) ? cause['evidenceIds'] : [];

        return [{
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
        }];
      },
    );
  }

  return r as unknown as InvestigationReport;
}
