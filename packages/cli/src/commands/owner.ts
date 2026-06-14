/**
 * `horus owner <query>` — estimate who likely owns a component from git history
 * (HOR-20). Confidence is probabilistic; never treat as authoritative.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { estimateOwnership, renderOwnership, ownershipToJSON } from '@horus/engine';

export async function runOwner(
  query: string,
  opts: { config?: string; repo?: string; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const code = codeForRepo(config, renv.project);

    const o = await estimateOwnership(query, { code, repoPath: renv.path });

    console.log(opts.json ? ownershipToJSON(o) : renderOwnership(o));

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
