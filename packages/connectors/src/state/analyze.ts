/**
 * Pure state-evidence helpers, shared by every state provider (MongoDB, Postgres, …).
 *
 * A datastore holds system STATE, not just storage. These helpers turn container
 * (collection / table) shape + counts into Evidence — never raw records. Generic by
 * design: no project-specific field names are hard-coded as logic, only as detection hints.
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

/**
 * Operational classification of a container by last-activity age:
 *  - active:  recent activity (< staleHours)
 *  - stale:   no recent activity but within the legacy horizon
 *  - legacy:  not touched in a very long time — likely an old/abandoned artifact
 *  - unknown: no usable date field
 */
export type Classification = 'active' | 'stale' | 'legacy' | 'unknown';

/** Default legacy horizon: ~90 days. Beyond this, treat state as a legacy artifact. */
export const DEFAULT_LEGACY_HOURS = 90 * 24;

export interface CollectionState {
  /** Container name — a Mongo collection or a Postgres table. */
  collection: string;
  count: number;
  dateField?: string;
  lastActivity?: string;
  ageHours?: number;
  isStale?: boolean;
  classification: Classification;
  statusField?: string;
  statusCounts?: StatusCount[];
  /** Status buckets whose value matches ANOMALOUS_STATUS. */
  anomalies: StatusCount[];
}

export interface StateAnalysis {
  database: string;
  staleHours: number;
  legacyHours: number;
  collections: CollectionState[];
  /** True when no allowlist was configured — containers were discovered from the database. */
  autoDiscovered?: boolean;
}

export function classifyAge(
  ageHours: number | undefined,
  staleHours: number,
  legacyHours: number,
): Classification {
  if (ageHours === undefined) return 'unknown';
  if (ageHours >= legacyHours) return 'legacy';
  if (ageHours >= staleHours) return 'stale';
  return 'active';
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

/** Split a string into lowercased word/identifier tokens of length >= 4. */
export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[^A-Za-z0-9]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 4);
}

/** Does a container name relate to any of the hint/seed terms? */
export function collectionMatchesTerms(collection: string, terms: string[]): boolean {
  if (terms.length === 0) return true; // no hint context => everything is "relevant"
  const cl = collection.toLowerCase();
  const singular = cl.endsWith('s') ? cl.slice(0, -1) : cl;
  return terms.some((t) => t.length >= 4 && (cl.includes(t) || t.includes(singular)));
}

export interface StateSignal {
  collection: string;
  kind: 'anomaly' | 'stale';
  classification: Classification;
  relevant: boolean;
  relevance: number;
  title: string;
  timestamp?: string;
  payload: Record<string, unknown>;
}

/**
 * Select the notable state signals, filtered + weighted by relevance to the hint
 * terms and by classification. Relevance discipline:
 *  - a stale/legacy container unrelated to the hint is dropped (it's just noise);
 *  - an ACTIVE anomaly is always surfaced (a currently-failing container matters),
 *    but down-weighted when it isn't hint-relevant;
 *  - legacy artifacts are heavily down-weighted and only shown when hint-relevant.
 */
export function selectStateSignals(
  analysis: StateAnalysis,
  terms: string[] = [],
): StateSignal[] {
  const signals: StateSignal[] = [];

  for (const c of analysis.collections) {
    const relevant = collectionMatchesTerms(c.collection, terms);
    const legacy = c.classification === 'legacy';

    for (const a of c.anomalies) {
      // Drop legacy/irrelevant anomalies; keep active ones (even if not relevant).
      if (!relevant && (legacy || c.classification !== 'active')) continue;
      const relevance = legacy ? 0.25 : relevant ? 0.85 : 0.5;
      const tag = legacy ? ' (legacy)' : c.classification === 'stale' ? ' (stale)' : '';
      signals.push({
        collection: c.collection,
        kind: 'anomaly',
        classification: c.classification,
        relevant,
        relevance,
        title: `${c.collection}: ${a.count} record(s) in state "${a.value}"${tag}`,
        payload: {
          collection: c.collection,
          statusField: c.statusField,
          status: a.value,
          count: a.count,
          totalRecords: c.count,
          classification: c.classification,
        },
      });
    }

    // Stale/legacy "no recent activity" is only worth surfacing when hint-relevant.
    if (c.isStale === true && c.lastActivity && relevant) {
      signals.push({
        collection: c.collection,
        kind: 'stale',
        classification: c.classification,
        relevant,
        relevance: legacy ? 0.25 : 0.6,
        title: `${c.collection}: ${legacy ? 'legacy' : 'stale'} — last ${c.dateField} ${fmtAge(c.ageHours ?? 0)} ago`,
        timestamp: c.lastActivity,
        payload: {
          collection: c.collection,
          dateField: c.dateField,
          lastActivity: c.lastActivity,
          ageHours: c.ageHours,
          classification: c.classification,
        },
      });
    }
  }

  signals.sort((x, y) => y.relevance - x.relevance);
  return signals;
}

/**
 * Convert a state analysis into Evidence. With no hint terms this surfaces all
 * notable signals (classification-weighted); pass hint terms to apply relevance
 * filtering. Counts + state only — never raw records.
 */
export function stateToEvidence(
  analysis: StateAnalysis,
  query: string,
  collectedAt: string,
  terms: string[] = [],
): Evidence[] {
  return selectStateSignals(analysis, terms).map((s, i) => ({
    id: `ev_state_${i}`,
    source: 'state' as const,
    kind: 'state' as const,
    title: s.title,
    relevance: s.relevance,
    payload: s.payload,
    links: {},
    provenance: { query, collectedAt },
    ...(s.timestamp ? { timestamp: s.timestamp } : {}),
  }));
}
