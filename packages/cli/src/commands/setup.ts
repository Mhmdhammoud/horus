/**
 * `horus setup` — verify the prerequisites are in place (HOR-37): the Horus
 * source-intelligence backend and the Horus Postgres. Guides the user to fix
 * anything missing. Does not modify the system.
 */

import pc from 'picocolors';
import { loadConfig } from '@horus/core';
import { getAxonVersion } from '@horus/connectors';
import { checkDatabase } from '@horus/db';
import { PINNED_AXON_VERSION } from '@horus/core';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

export async function runSetup(opts: { config?: string }): Promise<number> {
  console.log(pc.bold('\nHorus setup\n'));
  let ok = true;

  // 1. Source-intelligence backend — presence and version.
  const backendVersion = await getAxonVersion();
  if (backendVersion === null) {
    ok = false;
    console.log(`  ${pc.red('●')} Horus source-intelligence backend not found`);
    console.log(
      pc.dim(
        `      install it (Python 3.11+ required):\n` +
        `        uv tool install axoniq==${PINNED_AXON_VERSION}\n` +
        `      or: pip install axoniq==${PINNED_AXON_VERSION}\n` +
        `      ensure ~/.local/bin is on your PATH`,
      ),
    );
  } else if (backendVersion !== PINNED_AXON_VERSION) {
    ok = false;
    console.log(
      `  ${pc.yellow('●')} Horus source-intelligence backend version mismatch` +
      pc.dim(` (installed: ${backendVersion}, required: ${PINNED_AXON_VERSION})`),
    );
    console.log(
      pc.dim(
        `      update it:\n` +
        `        uv tool install axoniq==${PINNED_AXON_VERSION}\n` +
        `      or: pip install axoniq==${PINNED_AXON_VERSION}`,
      ),
    );
  } else {
    console.log(
      `  ${pc.green('●')} Horus source-intelligence backend ` +
      pc.dim(`(${backendVersion})`),
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
      console.log(
        pc.dim(
          `      schema not applied — run migrations:\n` +
          `        from the Horus repo: pnpm db migrate\n` +
          `        or apply the schema directly: https://github.com/Mhmdhammoud/horus/tree/master/packages/db/drizzle`,
        ),
      );
    }
  } else {
    ok = false;
    console.log(`  ${pc.red('●')} Postgres unreachable`);
    console.log(
      pc.dim(
        `      start a local instance:\n` +
        `        docker run -d --name horus-db \\\n` +
        `          -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n` +
        `          -p 5433:5432 postgres:16\n` +
        `      or set DATABASE_URL to an existing Postgres 16 instance`,
      ),
    );
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
