import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createConnectors } from '@horus/connectors';
import { changeImpact, renderChangeImpact, changeImpactToJSON } from '@horus/engine';

export async function runChanges(
  base: string,
  compare: string | undefined,
  opts: { config?: string; json?: boolean },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);
    const { code } = createConnectors(config);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Source-intelligence host unreachable — start it with: axon host --port 8420'),
      );
      return 1;
    }

    const report = await changeImpact({ base, compare }, { code });
    console.log(opts.json ? changeImpactToJSON(report) : renderChangeImpact(report));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
