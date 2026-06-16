import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, getInvestigation, listInvestigationsWithReports } from '@horus/db';
import { formatDateTime } from '../lib/format.js';
import {
  scoreInvestigation,
  renderScore,
  scoreToJSON,
  migrateReport,
} from '@horus/engine';
import type { InvestigationReport } from '@horus/engine';

export async function runScore(
  id: string,
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
    const s = scoreInvestigation(migrateReport(row.report) as InvestigationReport);
    console.log(opts.json ? scoreToJSON(s) : renderScore(s));
  } finally {
    await sql.end();
  }
  return 0;
}

export async function runScores(opts: {
  config?: string;
  limit?: number;
}): Promise<number> {
  const config = await loadConfig(opts.config);
  const { db, sql } = createDb(config.database.url);
  try {
    const rows = await listInvestigationsWithReports(db, opts.limit ?? 15);
    const scored = rows
      .filter((r) => r.report)
      .map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.createdAt,
        score: scoreInvestigation(migrateReport(r.report) as InvestigationReport).score,
      }));
    if (scored.length === 0) {
      console.log('No scored investigations yet.');
      return 0;
    }
    for (const s of scored) {
      console.log(
        '  ' +
          String(s.score).padStart(3) +
          '/100  ' +
          formatDateTime(s.createdAt) +
          '  ' +
          s.id +
          '  ' +
          (s.title ?? ''),
      );
    }
    const avg = Math.round(
      scored.reduce((n, s) => n + s.score, 0) / scored.length,
    );
    console.log('  avg ' + avg + '/100 across ' + scored.length + ' investigation(s)');
  } finally {
    await sql.end();
  }
  return 0;
}
