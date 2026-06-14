import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { AxonHttpClient, axonHostUrlForRepo } from '@horus/connectors';
import { createDb } from '@horus/db';
import { stitch } from '@horus/stitcher';

export async function runIndex(opts: { config?: string }): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    // HOR-34: the Axon host is now per project/environment. Resolve the default
    // (single) project/env's Axon host.
    const hostUrl = axonHostUrlForRepo(config);
    if (!hostUrl) {
      console.error(pc.red('No Axon connector configured for the default project/env.'));
      return 1;
    }
    const axon = new AxonHttpClient({ baseUrl: hostUrl });

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
