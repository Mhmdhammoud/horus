import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
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

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.repo });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const { code } = createConnectors(config);

    const t = await reconstructChangeTimeline(
      { repoPath: renv.path, since: opts.since, until: opts.until, service },
      { code },
    );

    console.log(opts.json ? changeTimelineToJSON(t) : renderChangeTimeline(t));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
