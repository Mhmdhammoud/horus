import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb } from '@horus/db';
import { listQueueEdges } from '@horus/db';
import type { QueueEdge } from '@horus/db';

export async function runQueues(
  name: string | undefined,
  opts: { config?: string },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { db, sql } = createDb(config.database.url);

    try {
      const rows = await listQueueEdges(db, name);

      if (rows.length === 0) {
        console.log('No queue edges. Run: horus index');
        return 0;
      }

      // Group rows by queueName
      const byQueue = new Map<string, QueueEdge[]>();
      for (const row of rows) {
        const existing = byQueue.get(row.queueName);
        if (existing) {
          existing.push(row);
        } else {
          byQueue.set(row.queueName, [row]);
        }
      }

      for (const [queueName, edges] of byQueue) {
        console.log(pc.bold(queueName));

        // Distinct non-null producerSymbol values
        const producerSet = new Set<string>();
        const producerDetails = new Map<string, string>();
        for (const edge of edges) {
          if (edge.producerSymbol) {
            producerSet.add(edge.producerSymbol);
            if (edge.producerFile) {
              producerDetails.set(edge.producerSymbol, edge.producerFile);
            }
          }
        }

        if (producerSet.size === 0) {
          console.log('  producers: ' + pc.dim('none'));
        } else {
          const producerList = Array.from(producerSet)
            .map((sym) => {
              const file = producerDetails.get(sym);
              return file ? `${sym} (${file})` : sym;
            })
            .join(', ');
          console.log('  producers: ' + producerList);
        }

        // Distinct non-null workerSymbol values
        const workerSet = new Set<string>();
        const workerDetails = new Map<string, string>();
        for (const edge of edges) {
          if (edge.workerSymbol) {
            workerSet.add(edge.workerSymbol);
            if (edge.workerFile) {
              workerDetails.set(edge.workerSymbol, edge.workerFile);
            }
          }
        }

        if (workerSet.size === 0) {
          console.log('  workers: ' + pc.dim('none'));
        } else {
          const workerList = Array.from(workerSet)
            .map((sym) => {
              const file = workerDetails.get(sym);
              return file ? `${sym} (${file})` : sym;
            })
            .join(', ');
          console.log('  workers: ' + workerList);
        }

        console.log('');
      }
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
