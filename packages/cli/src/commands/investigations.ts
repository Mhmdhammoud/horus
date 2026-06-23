import pc from 'picocolors';
import { openDb, listInvestigations } from '@horus/db';
import { formatDateTime } from '../lib/format.js';
import { resolveDbUrl } from '../lib/db-url.js';
import { readCloudConfig, isCloudActive } from '../lib/cloud/context-store.js';
import { authedClient, repoRootOrCwd } from '../lib/cloud/session.js';
import { listCloudInvestigations } from '../lib/cloud/investigation-sync.js';
import { reportCloudError } from './context.js';

export async function runInvestigations(opts: {
  config?: string;
  limit?: number;
}): Promise<number> {
  const repoRoot = repoRootOrCwd();
  const cloudCfg = readCloudConfig(repoRoot);

  if (isCloudActive(cloudCfg)) {
    const session = authedClient();
    if (!session) {
      console.error(
        pc.red(
          `This repo is linked to Horus Cloud but you are not logged in. Run ${pc.bold('horus login')} first.`,
        ),
      );
      return 1;
    }
    try {
      const rows = await listCloudInvestigations(session.client, cloudCfg);
      if (rows.length === 0) {
        console.log('No investigations yet. Run: horus investigate "<hint>"');
      } else {
        for (const row of rows) {
          const ts = formatDateTime(new Date(row.createdAt));
          const title = (row.title ?? '').length > 60
            ? (row.title ?? '').slice(0, 57) + '...'
            : (row.title ?? '');
          console.log(`${row.id}  ${ts}  ${title}`);
        }
      }
    } catch (err) {
      return reportCloudError(err);
    }
    return 0;
  }

  const { db, sql } = await openDb(await resolveDbUrl(opts.config));
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
