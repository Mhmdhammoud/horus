/**
 * `horus state` — surface application-STATE evidence from MongoDB (HOR-33).
 * Read-only, allowlisted collections only. Reports counts, staleness, and
 * anomalous status distributions — never raw documents.
 */

import pc from 'picocolors';
import { loadConfig, resolveEnvironment } from '@horus/core';
import { mongoForEnv } from '@horus/connectors';

export async function runState(opts: {
  config?: string;
  project?: string;
  env?: string;
  staleHours?: string;
}): Promise<number> {
  try {
    const config = await loadConfig(opts.config);

    let renv;
    try {
      renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }

    const mongo = mongoForEnv(renv);
    if (mongo === null) {
      console.error(
        pc.red(
          `No MongoDB connector configured for ${renv.project}/${renv.env} ` +
            `(set the project's Mongo URL env var).`,
        ),
      );
      return 1;
    }

    const health = await mongo.health();
    if (!health.ok) {
      console.error(pc.red(`MongoDB unreachable: ${health.detail}`));
      await mongo.close();
      return 1;
    }

    try {
      const staleHours = opts.staleHours !== undefined ? Number(opts.staleHours) : undefined;
      const analysis = await mongo.analyzeState(
        staleHours !== undefined ? { staleHours } : {},
      );

      console.log(
        pc.bold('State analysis') +
          pc.dim(` — ${renv.project}/${renv.env} · db ${analysis.database}`),
      );
      console.log('');

      let signals = 0;
      for (const c of analysis.collections) {
        const flags: string[] = [];
        if (c.isStale === true) {
          flags.push(pc.yellow(`stale (last ${c.dateField}, ~${Math.round(c.ageHours ?? 0)}h)`));
        }
        for (const a of c.anomalies) {
          flags.push(pc.red(`${a.count}× "${a.value}"`));
          signals += 1;
        }
        if (c.isStale === true) signals += 1;

        const head = `  ${pc.bold(c.collection.padEnd(18).slice(0, 18))} ${pc.dim(String(c.count).padStart(8) + ' docs')}`;
        console.log(flags.length > 0 ? `${head}   ${flags.join('  ')}` : pc.dim(head));
      }

      console.log('');
      console.log(
        signals > 0
          ? `  ${pc.bold(String(signals))} state signal(s) across ${analysis.collections.length} allowlisted collection(s)`
          : pc.dim(`  No state anomalies across ${analysis.collections.length} collection(s).`),
      );
      return 0;
    } finally {
      await mongo.close();
    }
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
