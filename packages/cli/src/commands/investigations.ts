import { createDb, listInvestigations } from '@horus/db';
import { formatDateTime } from '../lib/format.js';
import { resolveDbUrl } from '../lib/db-url.js';

export async function runInvestigations(opts: {
  config?: string;
  limit?: number;
}): Promise<number> {
  const { db, sql } = createDb(await resolveDbUrl(opts.config));
  try {
    const rows = await listInvestigations(db, opts.limit ?? 20);
    if (rows.length === 0) {
      console.log('No investigations yet. Run: horus investigate "<hint>"');
    } else {
      for (const row of rows) {
        const ts = formatDateTime(row.createdAt);
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
