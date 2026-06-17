import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import {
  reconstructChangeTimeline,
  renderChangeTimeline,
  changeTimelineToJSON,
} from '@horus/engine';

// Same default window as `horus what-changed` — a bounded, investigation-useful range
// instead of all history (which buried real signal under hundreds of commits, HOR-202).
const DEFAULT_SINCE = '7 days ago';

/**
 * Resolve the git `--since` window for the timeline. Defaults to the recent window;
 * `--all` opts into full history (wins over `--since`); an explicit `--since` overrides
 * the default. `usingDefault` is true only when neither `--all` nor `--since` was given.
 */
export function resolveTimelineWindow(opts: { since?: string; all?: boolean }): {
  since: string | undefined;
  usingDefault: boolean;
} {
  const usingDefault = !opts.all && opts.since === undefined;
  const since = opts.all ? undefined : (opts.since ?? DEFAULT_SINCE);
  return { since, usingDefault };
}

export async function runTimeline(
  service: string | undefined,
  opts: {
    config?: string;
    repo?: string;
    since?: string;
    until?: string;
    json?: boolean;
    /** Include all history instead of the default recent window. */
    all?: boolean;
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

    // Default to a bounded recent window for incident investigation (see helper).
    const { since, usingDefault: usingDefaultWindow } = resolveTimelineWindow(opts);

    const t = await reconstructChangeTimeline(
      { repoPath: renv.path, since, until: opts.until, service },
      { code },
    );

    if (opts.json) {
      console.log(changeTimelineToJSON(t));
    } else {
      console.log(renderChangeTimeline(t));
      if (usingDefaultWindow) {
        console.log(
          pc.dim(
            `\n  Showing the last 7 days (default). Widen with ` +
              `${pc.bold('--since "30 days ago"')}, pin a range with ` +
              `${pc.bold('--since <when> --until <when>')}, or see everything with ` +
              `${pc.bold('--all')}.`,
          ),
        );
      }
    }
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
