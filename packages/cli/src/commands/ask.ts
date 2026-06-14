import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation } from '@horus/db';
import {
  refineInvestigation,
  renderRefined,
  refinedToJSON,
} from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';

/**
 * HOR-21 — ask: apply a follow-up directive to a saved investigation.
 *
 * Reads the persisted report from Postgres and reuses its evidence to produce
 * a refined view — never re-queries Axon or any production connector.
 */
export async function runAsk(
  id: string,
  directive: string,
  opts: { config?: string; json?: boolean },
): Promise<number> {
  const config = await loadConfig(opts.config);
  const { db, sql } = createDb(config.database.url);
  try {
    const row = await getInvestigation(db, id);
    if (!row) {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    if (!row.report) {
      console.error(pc.red('Investigation ' + id + ' has no stored report.'));
      return 1;
    }
    const report = row.report as InvestigationReport;
    const v = refineInvestigation(report, directive);
    console.log(opts.json ? refinedToJSON(report, v) : renderRefined(report, v));
  } catch (err) {
    // A malformed id is not a valid UUID; Postgres rejects the cast with
    // SQLSTATE 22P02. Treat that the same as "no such investigation" rather
    // than leaking a raw driver error.
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code: unknown }).code)
        : undefined;
    if (code === '22P02') {
      console.error(pc.red('No investigation found: ' + id));
      return 1;
    }
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    return 1;
  } finally {
    await sql.end();
  }
  return 0;
}
