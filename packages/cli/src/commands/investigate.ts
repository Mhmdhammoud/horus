import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { codeForEnv, logsForEnv, mongoForEnv } from '@horus/connectors';
import { createDb } from '@horus/db';
import { investigate, renderReport, reportToJSON, reportToMarkdown } from '@horus/engine';

export async function runInvestigate(
  hint: string,
  opts: {
    config?: string;
    project?: string;
    env?: string;
    /** @deprecated use project — kept for back-compat with parked commands */
    repo?: string;
    since?: string;
    service?: string;
    json?: boolean;
    format?: string;
  },
): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    // --repo is the legacy name; --project takes precedence when both are given.
    const projectName = opts.project ?? opts.repo;

    let renv;
    try {
      renv = resolveEnvironment(config, { project: projectName, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const code = codeForEnv(renv);
    if (!code) {
      console.error(
        pc.red(
          `No Axon connector configured for project "${renv.project}" / env "${renv.env}".`,
        ),
      );
      return 1;
    }

    const health = await code.health();
    if (!health.ok) {
      const axonUrl = renv.repositories[0]?.axonHostUrl;
      console.error(
        pc.red(
          `Axon host unreachable for ${renv.project}/${renv.env}` +
            (axonUrl ? ` — start it with: axon host (${axonUrl})` : ''),
        ),
      );
      return 1;
    }

    const logs = logsForEnv(renv);
    const mongo = mongoForEnv(renv);

    // Resolve service name: CLI flag > connector default > undefined
    const service = opts.service ?? renv.connectors.elasticsearch?.serviceName;

    const { db, sql } = createDb(config.database.url);
    try {
      const report = await investigate(
        { hint, repo: projectName, since: opts.since, service },
        { code, db, logs, mongo },
      );
      // --json is back-compat for --format json.
      const format = opts.json ? 'json' : (opts.format ?? 'text');
      const rendered =
        format === 'json'
          ? reportToJSON(report)
          : format === 'markdown' || format === 'md'
            ? reportToMarkdown(report)
            : renderReport(report);
      console.log(rendered);
    } finally {
      await sql.end();
      if (mongo) await mongo.close();
    }

    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
