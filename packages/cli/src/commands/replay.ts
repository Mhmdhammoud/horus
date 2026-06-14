import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation } from '@horus/db';
import { renderReport, reportToMarkdown, reportToJSON } from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';

export async function runReplay(
  id: string,
  opts: { config?: string; format?: string },
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
      console.error(
        pc.red(
          'Investigation ' +
            id +
            ' has no stored report (run a newer investigation).',
        ),
      );
      return 1;
    }
    const report = row.report as InvestigationReport;
    const fmt = opts.format ?? 'text';
    const out =
      fmt === 'json'
        ? reportToJSON(report)
        : fmt === 'markdown' || fmt === 'md'
          ? reportToMarkdown(report)
          : renderReport(report);
    console.log(out);
  } finally {
    await sql.end();
  }
  return 0;
}
