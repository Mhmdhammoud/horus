/**
 * `horus setup` — verify the prerequisites are in place (HOR-37): the Axon CLI
 * (the default source-intelligence backend) and the Horus Postgres. Guides the
 * user to fix anything missing. Does not modify the system.
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { axonAvailable } from '@horus/connectors';
import { checkDatabase } from '@horus/db';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

export async function runSetup(opts: { config?: string }): Promise<number> {
  console.log(pc.bold('\nHorus setup\n'));
  let ok = true;

  // 1. Axon CLI — the default source-intelligence backend.
  if (await axonAvailable()) {
    console.log(`  ${pc.green('●')} Axon CLI found on PATH`);
  } else {
    ok = false;
    console.log(`  ${pc.red('●')} Axon CLI not found`);
    console.log(
      pc.dim('      install it (e.g. `uv tool install axoniq`) and ensure ~/.local/bin is on PATH'),
    );
  }

  // 2. Horus's own Postgres.
  let dbUrl = process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  try {
    const config = await loadConfig(opts.config);
    dbUrl = config.database.url;
  } catch {
    // No config resolvable here — fall back to the default DB URL.
  }
  const db = await checkDatabase(dbUrl);
  if (db.reachable) {
    console.log(`  ${pc.green('●')} Postgres reachable ${pc.dim(`(${db.schemaDetail})`)}`);
    if (!db.schemaReady) {
      ok = false;
      console.log(pc.dim('      run migrations: `pnpm db migrate`'));
    }
  } else {
    ok = false;
    console.log(`  ${pc.red('●')} Postgres unreachable`);
    console.log(pc.dim('      start it: `docker compose up -d`'));
  }

  console.log('');
  if (ok) {
    console.log(
      pc.green('Ready.') + ' Next: `cd` into a repo and run `horus index`, then `horus investigate "<hint>"`.',
    );
  } else {
    console.log(pc.yellow('Resolve the items above, then re-run `horus setup`.'));
  }
  return ok ? 0 : 1;
}
