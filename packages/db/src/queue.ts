import { eq } from 'drizzle-orm';
import type { HorusDb } from './client.js';
import { queueEdges, type NewQueueEdge, type QueueEdge } from './schema.js';

/** Replace all stitcher-produced queue edges atomically (delete source='stitcher', insert fresh). */
export async function replaceQueueEdges(db: HorusDb, edges: NewQueueEdge[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(queueEdges).where(eq(queueEdges.source, 'stitcher'));
    if (edges.length > 0) await tx.insert(queueEdges).values(edges);
  });
}

/** List queue edges, optionally filtered by queue name. */
export async function listQueueEdges(db: HorusDb, queueName?: string): Promise<QueueEdge[]> {
  if (queueName) return db.select().from(queueEdges).where(eq(queueEdges.queueName, queueName));
  return db.select().from(queueEdges);
}
