import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { createDb } from '@horus/db';
import { discoverArchitecture, renderArchitecture, architectureToJSON } from '@horus/engine';

export async function runArchitecture(opts: {
  config?: string;
  repo?: string;
  json?: boolean;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Source-intelligence host unreachable — run: horus index'),
      );
      return 1;
    }

    // Resolve the active project so async boundaries (queue edges) are scoped to it —
    // otherwise another project's queues leak into this repo's architecture (HOR-207).
    let project: string | undefined;
    try {
      project = resolveEnvironment(config, { project: opts.repo }).project;
    } catch {
      /* unresolvable (multi-project, no cwd match) — leave unscoped */
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const m = await discoverArchitecture({ code, db, project });
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
