import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { createDb } from '@horus/db';
import { investigate, renderReport, reportToJSON } from '@horus/engine';

export async function runInvestigate(
  hint: string,
  opts: { config?: string; repo?: string; since?: string; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Axon host unreachable — start it with: axon host --port 8420'),
      );
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const report = await investigate(
        { hint, repo: opts.repo, since: opts.since },
        { code, db },
      );
      console.log(opts.json ? reportToJSON(report) : renderReport(report));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
