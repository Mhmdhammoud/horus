import { desc, eq } from 'drizzle-orm';
import type { HorusDb } from './client.js';
import { investigations } from './schema.js';

/** Update the stored report JSON blob for an investigation (used to persist AI judgment). */
export async function updateInvestigationReport(
  db: HorusDb,
  id: string,
  report: unknown,
): Promise<void> {
  await db
    .update(investigations)
    .set({ report })
    .where(eq(investigations.id, id));
}

export async function getInvestigation(db: HorusDb, id: string) {
  const rows = await db
    .select()
    .from(investigations)
    .where(eq(investigations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Return the id of the most recently created investigation, or null when none exist.
 * Same ordering as {@link listInvestigations} (createdAt desc) so "the last investigation"
 * means the same row both surfaces would show first. Powers `horus feedback` with no id.
 */
export async function getLastInvestigationId(db: HorusDb): Promise<string | null> {
  const rows = await db
    .select({ id: investigations.id })
    .from(investigations)
    .orderBy(desc(investigations.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function listInvestigations(db: HorusDb, limit = 20) {
  return db
    .select({
      id: investigations.id,
      title: investigations.title,
      status: investigations.status,
      summary: investigations.summary,
      createdAt: investigations.createdAt,
    })
    .from(investigations)
    .orderBy(desc(investigations.createdAt))
    .limit(limit);
}

export async function listInvestigationsWithReports(db: HorusDb, limit = 20) {
  return db
    .select({
      id: investigations.id,
      title: investigations.title,
      createdAt: investigations.createdAt,
      report: investigations.report,
    })
    .from(investigations)
    .orderBy(desc(investigations.createdAt))
    .limit(limit);
}
