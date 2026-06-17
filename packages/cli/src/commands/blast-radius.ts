import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { createDb } from '@horus/db';
import { analyzeBlastRadius, renderBlastRadius, blastRadiusToJSON } from '@horus/engine';

export async function runBlastRadius(
  query: string,
  opts: { config?: string; repo?: string; depth?: number; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(pc.red('Source-intelligence host unreachable — run: horus index'));
      return 1;
    }

    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable — leave unscoped */
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const r = await analyzeBlastRadius(query, { code, db, project }, opts.depth ?? 3);
      if (!r) {
        console.log(`No symbol found for: ${query}`);
        console.log(pc.dim(`  Tip: use an exact class or function name, e.g. "MyService"`));
        return 1;
      }
      if (r.seed.name.toLowerCase() !== query.toLowerCase()) {
        console.log(
          pc.yellow(`  No exact match for "${query}"`) +
            pc.dim(` — showing closest: "${r.seed.name}" (fuzzy match)`),
        );
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
