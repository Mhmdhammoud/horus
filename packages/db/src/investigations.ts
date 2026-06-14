import { desc, eq } from 'drizzle-orm';
import type { HorusDb } from './client.js';
import { investigations } from './schema.js';

export async function getInvestigation(db: HorusDb, id: string) {
  const rows = await db
    .select()
    .from(investigations)
    .where(eq(investigations.id, id))
    .limit(1);
  return rows[0] ?? null;
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
