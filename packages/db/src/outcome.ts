/**
 * Outcome-label / eval store API (HOR-390).
 *
 * A small, queryable store of investigation outcome labels keyed by `investigationId`. It is
 * the persisted, evaluable record of Horus's own accuracy — the flywheel's eval/training set —
 * and the single sink that `horus feedback` and `horus memory confirm` both write to.
 *
 * The store is append-only: `recordOutcomeLabel` always inserts a new row, so the dataset keeps
 * every attestation (and corrections to it) as a data point. Use `getLatestOutcomeLabel` for the
 * current verdict on an investigation, and `listOutcomeLabels` to slice the dataset by project,
 * source, verdict, and date range for accuracy reporting.
 */
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { HorusDb } from './client.js';
import { outcomeLabel, type OutcomeLabel } from './schema.js';

/** Verdicts an attester can give: did Horus point at the real cause? */
export const OUTCOME_RESOLVED = ['yes', 'partly', 'no'] as const;
export type OutcomeResolved = (typeof OUTCOME_RESOLVED)[number];

/** The two entry points that converge into the eval store (HOR-390). */
export const OUTCOME_SOURCE = ['feedback', 'confirm'] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCE)[number];

/** Type guards — keep validation pure so callers (CLI/engine) can reject bad input early. */
export function isOutcomeResolved(v: unknown): v is OutcomeResolved {
  return typeof v === 'string' && (OUTCOME_RESOLVED as readonly string[]).includes(v);
}

export function isOutcomeSource(v: unknown): v is OutcomeSource {
  return typeof v === 'string' && (OUTCOME_SOURCE as readonly string[]).includes(v);
}

/** The label payload an entry point records. `at` defaults to now; `id` is generated. */
export interface OutcomeLabelInput {
  investigationId: string;
  resolved: OutcomeResolved;
  source: OutcomeSource;
  confirmedCause?: string | null;
  note?: string | null;
  /** Denormalized repo/project scope, so accuracy can be sliced per project. */
  project?: string | null;
  /** Forward-compat extras (e.g. manualEstimateMinutes, horusSeconds). */
  payload?: unknown;
  /** Override the attestation time (defaults to the DB `now()`). */
  at?: Date;
}

/**
 * Persist one outcome label (append-only). Throws on an invalid `resolved`/`source` so a bad
 * value never silently pollutes the eval set. Returns the inserted row.
 */
export async function recordOutcomeLabel(
  db: HorusDb,
  input: OutcomeLabelInput,
): Promise<OutcomeLabel> {
  if (!isOutcomeResolved(input.resolved)) {
    throw new Error(
      `invalid resolved "${String(input.resolved)}" — expected one of ${OUTCOME_RESOLVED.join('|')}`,
    );
  }
  if (!isOutcomeSource(input.source)) {
    throw new Error(
      `invalid source "${String(input.source)}" — expected one of ${OUTCOME_SOURCE.join('|')}`,
    );
  }
  const rows = await db
    .insert(outcomeLabel)
    .values({
      investigationId: input.investigationId,
      resolved: input.resolved,
      source: input.source,
      confirmedCause: input.confirmedCause ?? null,
      note: input.note ?? null,
      project: input.project ?? null,
      payload: input.payload ?? null,
      ...(input.at ? { at: input.at } : {}),
    })
    .returning();
  return rows[0]!;
}

/** Filter/slice options for querying the eval dataset. */
export interface OutcomeLabelQuery {
  investigationId?: string;
  project?: string;
  source?: OutcomeSource;
  resolved?: OutcomeResolved;
  /** Inclusive lower bound on `at`. */
  since?: Date;
  /** Inclusive upper bound on `at`. */
  until?: Date;
  limit?: number;
}

/**
 * List outcome labels newest-first, filtered by any combination of investigation, project,
 * source, verdict, and date range. With no options it returns the whole dataset (newest-first,
 * capped by `limit`).
 */
export async function listOutcomeLabels(
  db: HorusDb,
  opts: OutcomeLabelQuery = {},
): Promise<OutcomeLabel[]> {
  const conditions = [];
  if (opts.investigationId !== undefined)
    conditions.push(eq(outcomeLabel.investigationId, opts.investigationId));
  if (opts.project !== undefined) conditions.push(eq(outcomeLabel.project, opts.project));
  if (opts.source !== undefined) conditions.push(eq(outcomeLabel.source, opts.source));
  if (opts.resolved !== undefined) conditions.push(eq(outcomeLabel.resolved, opts.resolved));
  if (opts.since !== undefined) conditions.push(gte(outcomeLabel.at, opts.since));
  if (opts.until !== undefined) conditions.push(lte(outcomeLabel.at, opts.until));

  const base = db.select().from(outcomeLabel).orderBy(desc(outcomeLabel.at));
  const filtered =
    conditions.length === 0
      ? base
      : base.where(conditions.length === 1 ? conditions[0] : and(...conditions));
  return opts.limit !== undefined ? filtered.limit(opts.limit) : filtered;
}

/**
 * The current verdict for an investigation: the most recently attested label, or null if none.
 * Append-only history means an investigation can have several labels; this collapses them.
 */
export async function getLatestOutcomeLabel(
  db: HorusDb,
  investigationId: string,
): Promise<OutcomeLabel | null> {
  const rows = await db
    .select()
    .from(outcomeLabel)
    .where(eq(outcomeLabel.investigationId, investigationId))
    .orderBy(desc(outcomeLabel.at))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The accuracy summary of a set of outcome labels — Horus's own measured hit-rate over the eval
 * set. Pure (no DB), so it is trivially testable and reusable by the CLI/cloud/web read paths.
 */
export interface OutcomeAccuracy {
  /** Distinct investigations that carry at least one verdict. */
  evaluated: number;
  /** Total label rows considered (the append-only history can exceed `evaluated`). */
  attestations: number;
  /** Counts over the CURRENT verdict (latest label) per investigation. */
  counts: { yes: number; partly: number; no: number };
  /** Strict hit-rate: `yes / evaluated` (0 when nothing is evaluated). */
  accuracy: number;
  /** Partial-credit score: `(yes + 0.5·partly) / evaluated` (0 when nothing is evaluated). */
  weightedScore: number;
  /** Which entry point attested the CURRENT verdict, across investigations. */
  bySource: { feedback: number; confirm: number };
}

/**
 * Collapse an append-only label set to the CURRENT verdict per investigation: the latest `at`,
 * tie-broken by greater `id` for determinism. A null `investigationId` (legacy/unlinked) is bucketed
 * ALONE (keyed by its row id) so it never collapses with another investigation's verdict.
 *
 * Order-independent. This is the single shared definition of "current verdict" — both
 * `summarizeOutcomeLabels` (and thus `horus memory accuracy`) and the read-only eval harness
 * (`@horus/eval`, HOR-403) import it, so the harness and the accuracy report can never diverge on
 * which label is the current one.
 */
export function dedupeToCurrentVerdict(labels: readonly OutcomeLabel[]): OutcomeLabel[] {
  const latest = new Map<string, OutcomeLabel>();
  for (const l of labels) {
    // Null investigationId (legacy/unlinked) is its own bucket so it never collapses with others.
    const key = l.investigationId ?? `__row_${l.id}`;
    const cur = latest.get(key);
    if (
      cur === undefined ||
      l.at.getTime() > cur.at.getTime() ||
      (l.at.getTime() === cur.at.getTime() && l.id > cur.id)
    ) {
      latest.set(key, l);
    }
  }
  return [...latest.values()];
}

/**
 * Collapse a set of outcome labels into an accuracy summary. The store is append-only, so an
 * investigation may carry several labels (re-confirmations / corrections); this dedupes to the
 * CURRENT verdict per investigation (via `dedupeToCurrentVerdict`) before counting — so
 * re-attesting the same investigation never double-counts. `attestations` keeps the raw total.
 *
 * Order-independent: callers can pass labels in any order (the list path returns newest-first).
 */
export function summarizeOutcomeLabels(labels: readonly OutcomeLabel[]): OutcomeAccuracy {
  // Pick the current verdict per investigation (shared definition; max `at`, tie-broken by `id`).
  const latest = dedupeToCurrentVerdict(labels);

  const counts = { yes: 0, partly: 0, no: 0 };
  const bySource = { feedback: 0, confirm: 0 };
  for (const l of latest) {
    if (l.resolved === 'yes') counts.yes++;
    else if (l.resolved === 'partly') counts.partly++;
    else if (l.resolved === 'no') counts.no++;
    if (l.source === 'feedback') bySource.feedback++;
    else if (l.source === 'confirm') bySource.confirm++;
  }

  const evaluated = latest.length;
  return {
    evaluated,
    attestations: labels.length,
    counts,
    accuracy: evaluated === 0 ? 0 : counts.yes / evaluated,
    weightedScore: evaluated === 0 ? 0 : (counts.yes + 0.5 * counts.partly) / evaluated,
    bySource,
  };
}
