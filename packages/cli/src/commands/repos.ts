import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { repoProviders } from '@horus/connectors';
import { reposHealth } from '@horus/engine';

export async function runRepos(opts: { config?: string }): Promise<number> {
  const config = await loadConfig(opts.config);
  const providers = repoProviders(config);

  if (providers.length === 0) {
    console.log(pc.dim('No repositories configured.'));
    return 0;
  }

  const health = await reposHealth(providers);

  for (const h of health) {
    const dot = h.reachable ? pc.green('●') : pc.red('●');
    const name = pc.bold(h.repo.padEnd(20));
    const hostUrl = pc.cyan(h.hostUrl.padEnd(30));
    const path = pc.dim(h.path);
    const detail = h.detail ? pc.dim(`(${h.detail})`) : '';
    console.log(`  ${dot}  ${name}  ${hostUrl}  ${path}  ${detail}`);
  }

  return 0;
}
