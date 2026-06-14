/**
 * `horus owner <query>` — estimate who likely owns a component from git history
 * (HOR-20). Confidence is probabilistic; never treat as authoritative.
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { estimateOwnership, renderOwnership, ownershipToJSON } from '@horus/engine';

export async function runOwner(
  query: string,
  opts: { config?: string; repo?: string; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    const repo = opts.repo
      ? config.repos.find((r) => r.name === opts.repo)
      : config.repos[0];

    if (repo === undefined) {
      console.error(
        pc.red('No repo configured (set repos in horus.config.ts or pass --repo)'),
      );
      return 1;
    }

    const code = codeForRepo(config, repo.name);

    const o = await estimateOwnership(query, { code, repoPath: repo.path });

    console.log(opts.json ? ownershipToJSON(o) : renderOwnership(o));

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
