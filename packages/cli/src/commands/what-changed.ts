import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { whatChanged, renderWhatChanged, whatChangedToJSON } from '@horus/engine';

const DEFAULT_SINCE = '7 days ago';

export async function runWhatChanged(
  service: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    since?: string;
    until?: string;
    json?: boolean;
  },
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

    const { code } = createConnectors(config);

    const since = opts.since ?? DEFAULT_SINCE;

    const r = await whatChanged(
      { repoPath: repo.path, since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? whatChangedToJSON(r) : renderWhatChanged(r));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
