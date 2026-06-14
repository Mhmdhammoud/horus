/**
 * Pure state-evidence helpers for the MongoDB provider (HOR-33).
 *
 * MongoDB holds system STATE, not just storage. These helpers turn collection
 * shape + counts into Evidence — never raw documents. Generic by design: no
 * project-specific field names are hard-coded as logic, only as detection hints.
 */

import type { Evidence } from '@horus/core';

/** Conventional date/activity field names, in priority order. */
export const DATE_FIELDS = [
  'completedAt',
  'last_executed_at',
  'lastSyncedAt',
  'last_run_started_at',
  'updatedAt',
  'updated_at',
  'syncedAt',
  'startedAt',
  'createdAt',
  'created_at',
  'timestamp',
  'time',
  'date',
];

/** Conventional status/state field names, in priority order. */
export const STATUS_FIELDS = [
  'status',
  'last_run_status',
  'syncStatus',
  'state',
  'connectionStatus',
];

/** Status values that indicate a problem state. */
export const ANOMALOUS_STATUS =
  /fail|error|stuck|timeout|disconn|inactive|stale|cancel|dead|broken|pending|retry|unhealthy/i;

export interface StatusCount {
  value: string;
  count: number;
}

export interface CollectionState {
  collection: string;
  count: number;
  dateField?: string;
  lastActivity?: string;
  ageHours?: number;
  isStale?: boolean;
  statusField?: string;
  statusCounts?: StatusCount[];
  /** Status buckets whose value matches ANOMALOUS_STATUS. */
  anomalies: StatusCount[];
}

export interface StateAnalysis {
  database: string;
  staleHours: number;
  collections: CollectionState[];
}

/** First candidate present in `fields`. */
export function pickField(fields: string[], candidates: string[]): string | undefined {
  return candidates.find((c) => fields.includes(c));
}

export function isAnomalousStatus(value: string): boolean {
  return ANOMALOUS_STATUS.test(value);
}

/** Hours between an ISO timestamp and `nowMs` (>= 0; NaN-safe -> 0). */
export function ageHoursOf(iso: string, nowMs: number): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (nowMs - t) / 3_600_000);
}

function fmtAge(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  if (hours >= 1) return `${Math.round(hours)}h`;
  return `${Math.round(hours * 60)}m`;
}

/**
 * Convert a state analysis into Evidence: one record per anomalous status
 * bucket and per stale collection. Counts + state only — never raw documents.
 */
export function stateToEvidence(
  analysis: StateAnalysis,
  query: string,
  collectedAt: string,
): Evidence[] {
  const out: Evidence[] = [];
  let i = 0;

  for (const c of analysis.collections) {
    for (const a of c.anomalies) {
      out.push({
        id: `ev_state_${i++}`,
        source: 'state',
        kind: 'state',
        title: `${c.collection}: ${a.count} doc(s) in state "${a.value}"`,
        relevance: 0.85,
        payload: {
          collection: c.collection,
          statusField: c.statusField,
          status: a.value,
          count: a.count,
          totalDocs: c.count,
        },
        links: {},
        provenance: { query, collectedAt },
      });
    }

    if (c.isStale === true && c.lastActivity) {
      out.push({
        id: `ev_state_${i++}`,
        source: 'state',
        kind: 'state',
        title: `${c.collection}: stale — last ${c.dateField} ${fmtAge(c.ageHours ?? 0)} ago (> ${analysis.staleHours}h)`,
        relevance: 0.8,
        timestamp: c.lastActivity,
        payload: {
          collection: c.collection,
          dateField: c.dateField,
          lastActivity: c.lastActivity,
          ageHours: c.ageHours,
        },
        links: {},
        provenance: { query, collectedAt },
      });
    }
  }

  return out;
}
