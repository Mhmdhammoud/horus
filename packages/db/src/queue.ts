import { eq, and, isNull } from 'drizzle-orm';
import type { HorusDb } from './client.js';
import { queueEdges, type NewQueueEdge, type QueueEdge } from './schema.js';

/** Replace all stitcher-produced queue edges for a given project atomically. */
export async function replaceQueueEdges(
  db: HorusDb,
  edges: NewQueueEdge[],
  opts: { project?: string } = {},
): Promise<void> {
  const { project } = opts;
  await db.transaction(async (tx) => {
    const condition =
      project !== undefined
        ? and(eq(queueEdges.source, 'stitcher'), eq(queueEdges.project, project))
        : and(eq(queueEdges.source, 'stitcher'), isNull(queueEdges.project));
    await tx.delete(queueEdges).where(condition);
    if (edges.length > 0) await tx.insert(queueEdges).values(edges);
  });
}

/** List queue edges, optionally filtered by project and/or queue name. */
export async function listQueueEdges(
  db: HorusDb,
  opts: { project?: string; queueName?: string } = {},
): Promise<QueueEdge[]> {
  const { project, queueName } = opts;
  const conditions = [];
  if (project !== undefined) conditions.push(eq(queueEdges.project, project));
  if (queueName !== undefined) conditions.push(eq(queueEdges.queueName, queueName));
  if (conditions.length === 0) return db.select().from(queueEdges);
  if (conditions.length === 1) return db.select().from(queueEdges).where(conditions[0]);
  return db.select().from(queueEdges).where(and(...conditions));
}
