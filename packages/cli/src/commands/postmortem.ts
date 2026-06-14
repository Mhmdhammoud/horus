import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation } from '@horus/db';
import { generatePostmortem } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';

/**
 * HOR-26 — Draft an editable postmortem from a persisted investigation.
 * Read-only from Postgres; never touches Axon or connectors.
 */
export async function runPostmortem(
  id: string,
  opts: { config?: string },
): Promise<number> {
  let sql: { end: () => Promise<void> } | undefined;
  try {
    const config = await loadConfig(opts.config);
    const conn = createDb(config.database.url);
    sql = conn.sql;
    const { db } = conn;
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
    console.log(generatePostmortem(report));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(pc.red('postmortem failed: ' + message));
    return 1;
  } finally {
    if (sql) {
      await sql.end();
    }
  }
  return 0;
}
