import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { createDb } from '@horus/db';
import { buildOnboarding, renderOnboarding, onboardingToJSON } from '@horus/engine';

export async function runOnboard(
  area: string | undefined,
  opts: { config?: string; repo?: string; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    // --repo maps 1:1 to a project name (HOR-34 compat). Resolve the default/single
    // project/env when --repo is omitted.
    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }
    const repo = { name: renv.project, path: renv.path };

    const code = codeForRepo(config, repo.name);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Axon host unreachable — start it with: axon host --port 8420'),
      );
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const g = await buildOnboarding({ area }, { code, db, repoPath: repo.path });
      console.log(opts.json ? onboardingToJSON(g) : renderOnboarding(g));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
