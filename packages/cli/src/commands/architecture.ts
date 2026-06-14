import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { createDb } from '@horus/db';
import { discoverArchitecture, renderArchitecture, architectureToJSON } from '@horus/engine';

export async function runArchitecture(opts: {
  config?: string;
  json?: boolean;
}): Promise<number> {
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
      const m = await discoverArchitecture({ code, db });
      console.log(opts.json ? architectureToJSON(m) : renderArchitecture(m));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
