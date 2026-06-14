import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { codeForRepo } from '@horus/connectors';
import { createDb } from '@horus/db';
import {
  investigate,
  SCENARIOS,
  getScenario,
  evaluateScenario,
  renderScenarioList,
  renderSimulation,
} from '@horus/engine';

export async function runSimulate(
  scenarioId: string | undefined,
  opts: { config?: string; repo?: string },
): Promise<number> {
  try {
    // No scenario id — list all available scenarios.
    if (scenarioId === undefined) {
      console.log(renderScenarioList(SCENARIOS));
      return 0;
    }

    const scenario = getScenario(scenarioId);
    if (scenario === null) {
      console.error(
        pc.red(
          `Unknown scenario: "${scenarioId}". Run horus simulate to list available scenarios.`,
        ),
      );
      return 1;
    }

    const config = await loadConfig(opts.config);

    const repo = opts.repo
      ? config.repos.find((r) => r.name === opts.repo)
      : config.repos[0];

    const code = codeForRepo(config, repo?.name);

    const health = await code.health();
    if (!health.ok) {
      console.error(
        pc.red('Axon host unreachable — start it with: axon host --port 8420'),
      );
      return 1;
    }

    const { db, sql } = createDb(config.database.url);
    try {
      const report = await investigate(
        { hint: scenario.hint, since: scenario.since },
        { code, db },
      );
      const evaluation = evaluateScenario(scenario, report);
      console.log(renderSimulation(scenario, report, evaluation));
    } finally {
      await sql.end();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
