import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { createDb } from '@horus/db';
import { analyzeBlastRadius, renderBlastRadius, blastRadiusToJSON } from '@horus/engine';

export async function runBlastRadius(
  query: string,
  opts: { config?: string; depth?: number; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(pc.red('Axon host unreachable — start it with: axon host --port 8420'));
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const r = await analyzeBlastRadius(query, { code, db }, opts.depth ?? 3);
      if (!r) {
        console.log('No symbol found for: ' + query);
        return 1;
      }
      console.log(opts.json ? blastRadiusToJSON(r) : renderBlastRadius(r));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
