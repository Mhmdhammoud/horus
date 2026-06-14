import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
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

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const { code } = createConnectors(config);

    const since = opts.since ?? DEFAULT_SINCE;

    const r = await whatChanged(
      { repoPath: renv.path, since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? whatChangedToJSON(r) : renderWhatChanged(r));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
