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
