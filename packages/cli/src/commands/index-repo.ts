import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { AxonHttpClient } from '@horus/connectors';
import { createDb } from '@horus/db';
import { stitch } from '@horus/stitcher';

export async function runIndex(opts: { config?: string }): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const axon = new AxonHttpClient({ baseUrl: config.axon.hostUrl });

    const health = await axon.health();
    if (!health.ok) {
      console.error(pc.red('Axon host unreachable — start it with: axon host --port 8420'));
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const summary = await stitch(axon, db);
      console.log(
        'Stitched ' +
          summary.edges +
          ' queue edge(s) across ' +
          summary.queues +
          ' queue(s) — ' +
          summary.producers +
          ' producer(s), ' +
          summary.workers +
          ' worker(s).',
      );
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
