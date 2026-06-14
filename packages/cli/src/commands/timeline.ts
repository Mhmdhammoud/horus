import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import {
  reconstructChangeTimeline,
  renderChangeTimeline,
  changeTimelineToJSON,
} from '@horus/engine';

export async function runTimeline(
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

    const t = await reconstructChangeTimeline(
      { repoPath: repo.path, since: opts.since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? changeTimelineToJSON(t) : renderChangeTimeline(t));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
