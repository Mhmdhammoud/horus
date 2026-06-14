import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { AxonHttpClient } from '@horus/connectors';
import { createDb } from '@horus/db';
import { stitch } from '@horus/stitcher';

export async function runIndex(opts: {
  config?: string;
  name?: string;
  project?: string;
  env?: string;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config, { name: opts.name });

    // HOR-34: the Axon host is per project/environment. Resolve the chosen
    // project/env (or the single one). The queue map is replaced per run, so
    // index the project you are about to investigate.
    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const hostUrl = renv.repositories[0]?.axonHostUrl;
    if (!hostUrl) {
      console.error(
        pc.red(`No Axon repository configured for project ${renv.project}.`),
      );
      return 1;
    }
    const axon = new AxonHttpClient({ baseUrl: hostUrl });

    const health = await axon.health();
    if (!health.ok) {
      console.error(
        pc.red(
          `Axon host unreachable for ${renv.project}/${renv.env} (${hostUrl}) — start it with: axon host`,
        ),
      );
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const summary = await stitch(axon, db);
      console.log(
        pc.dim(`[${renv.project}/${renv.env}]  `) +
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
