/**
 * `horus setup` — verify the prerequisites are in place (HOR-37, HOR-84): the Horus
 * source-intelligence backend and the Horus Postgres. Guides the user to fix
 * anything missing. Does not modify the system.
 */

import pc from 'picocolors';
import { loadConfig, PINNED_SOURCE_VERSION } from '@horus/core';
import { getSourceVersion, SourceHttpClient } from '@horus/connectors';
import { checkDatabase } from '@horus/db';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

export async function runSetup(opts: {
  config?: string;
  write?: (line: string) => void;
}): Promise<number> {
  const write = opts.write ?? ((line: string) => console.log(line));
  let ok = true;

  write(pc.bold('\nHorus setup\n'));

  // 1. Source-intelligence backend — presence and version.
  const backendVersion = await getSourceVersion();
  if (backendVersion === null) {
    ok = false;
    write(`  ${pc.red('●')} Horus source-intelligence backend not found`);
    write(
      pc.dim(
        `      install it (Python 3.11+ required):\n` +
        `        pip install horus-source\n` +
        `      ensure ~/.local/bin is on your PATH`,
      ),
    );
  } else if (backendVersion !== PINNED_SOURCE_VERSION) {
    ok = false;
    write(
      `  ${pc.yellow('●')} Horus source-intelligence backend version mismatch` +
      pc.dim(` (installed: ${backendVersion}, required: ${PINNED_SOURCE_VERSION})`),
    );
    write(
      pc.dim(
        `      update it:\n` +
        `        pip install --upgrade horus-source`,
      ),
    );
  } else {
    write(
      `  ${pc.green('●')} Horus source-intelligence backend ` +
      pc.dim(`(${backendVersion})`),
    );
  }

  // 2. Horus's own Postgres.
  let dbUrl = process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig(opts.config);
    dbUrl = config.database.url;
  } catch {
    // No config resolvable — fall back to the default DB URL.
  }
  const db = await checkDatabase(dbUrl);
  if (db.reachable) {
    write(`  ${pc.green('●')} Postgres reachable ${pc.dim(`(${db.schemaDetail})`)}`);
    if (!db.schemaReady) {
      ok = false;
      write(
        pc.dim(
          `      schema not applied — run migrations:\n` +
          `        from the Horus repo: pnpm db migrate\n` +
          `        or apply the schema directly: https://github.com/meritt-dev/horus/tree/master/packages/db/drizzle`,
        ),
      );
    }
  } else {
    ok = false;
    write(`  ${pc.red('●')} Postgres unreachable`);
    write(
      pc.dim(
        `      start a local instance:\n` +
        `        docker run -d --name horus-db \\\n` +
        `          -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n` +
        `          -p 5433:5432 postgres:16\n` +
        `      or set DATABASE_URL to an existing Postgres 16 instance`,
      ),
    );
  }

  // 3. Source intelligence host reachability and repo indexing — per configured repository.
  if (config && config.projects.length > 0) {
    for (const project of config.projects) {
      for (const repo of project.repositories) {
        const repoHostUrl = repo.source?.hostUrl ?? repo.axon?.hostUrl;
        if (!repoHostUrl) {
          continue;
        }
        const client = new SourceHttpClient({
          baseUrl: repoHostUrl,
          timeoutMs: 3000,
          maxRetries: 0,
        });
        const health = await client.health();
        if (!health.ok) {
          ok = false;
          write(
            `  ${pc.red('●')} Source intelligence host unreachable for ${pc.bold(repo.name)} ` +
            pc.dim(`(${repoHostUrl})`),
          );
          write(
            pc.dim(
              `      start the source intelligence host:\n` +
              `        cd ${repo.path}\n` +
              `        horus index`,
            ),
          );
        } else {
          const count = await client.nodeCount().catch(() => 0);
          if (count === 0) {
            ok = false;
            write(
              `  ${pc.yellow('●')} Source intelligence host running but ${pc.bold(repo.name)} is not indexed`,
            );
            write(
              pc.dim(
                `      index the repo:\n` +
                `        cd ${repo.path}\n` +
                `        horus index`,
              ),
            );
          } else {
            write(
              `  ${pc.green('●')} ${pc.bold(repo.name)} — ${count} nodes indexed ` +
              pc.dim(`(${repoHostUrl})`),
            );
          }
        }
      }
    }
  }

  write('');
  if (ok) {
    write(
      pc.green('Ready.') + ' Next: `cd` into a repo and run `horus index`, then `horus investigate "<hint>"`.',
    );
  } else {
    write(pc.yellow('Resolve the items above, then re-run `horus setup`.'));
  }
  return ok ? 0 : 1;
}
