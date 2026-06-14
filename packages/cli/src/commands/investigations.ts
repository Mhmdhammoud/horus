import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { createDb, listInvestigations } from '@horus/db';

export async function runInvestigations(opts: {
  config?: string;
  limit?: number;
}): Promise<number> {
  const config = await loadConfig(opts.config);
  const { db, sql } = createDb(config.database.url);
  try {
    const rows = await listInvestigations(db, opts.limit ?? 20);
    if (rows.length === 0) {
      console.log('No investigations yet. Run: horus investigate "<hint>"');
    } else {
      for (const row of rows) {
        const ts = row.createdAt.toISOString();
        const title = (row.title ?? '').length > 60
          ? (row.title ?? '').slice(0, 57) + '...'
          : (row.title ?? '');
        console.log(`${row.id}  ${ts}  ${title}`);
      }
    }
  } finally {
    await sql.end();
  }
  return 0;
}
