import pc from 'picocolors';
import {
  HORUS_VERSION,
  findRepoRoot,
  discoverLocalConfig,
  readLocalConfig,
  loadConfig,
} from '@horus/core';
import { checkDatabase, type DbHealth } from '@horus/db';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  label: string;
  status: CheckStatus;
  detail: string;
  next?: string;
}

function mark(status: CheckStatus): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'warn') return pc.yellow('~');
  return pc.red('✗');
}

export async function runDoctor(opts?: {
  cwd?: string;
  config?: string;
  write?: (line: string) => void;
  /** Injectable for tests — defaults to the real checkDatabase. */
  _dbCheck?: (url: string) => Promise<DbHealth>;
}): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd();
  const write = opts?.write ?? ((line: string) => console.log(line));
  const checks: DoctorCheck[] = [];

  checks.push({
    label: 'CLI version',
    status: 'pass',
    detail: `horus ${HORUS_VERSION}`,
  });

  const repoRoot = findRepoRoot(cwd);
  if (repoRoot) {
    checks.push({ label: 'Git root', status: 'pass', detail: repoRoot });
  } else {
    checks.push({
      label: 'Git root',
      status: 'warn',
      detail: 'not in a git repository',
      next: 'run horus doctor from inside a git repository',
    });
  }

  const configPath = discoverLocalConfig(cwd);
  if (configPath) {
    checks.push({ label: 'Local config', status: 'pass', detail: configPath });

    try {
      const file = readLocalConfig(configPath);
      const project = file.project as Record<string, unknown>;
      const repos = project['repositories'] as Array<Record<string, unknown>> | undefined;
      const hasHost = repos?.some(
        (r) => (r['axon'] as Record<string, unknown> | undefined)?.['hostUrl'],
      );
      if (hasHost) {
        checks.push({ label: 'Source-intelligence host', status: 'pass', detail: 'configured' });
      } else {
        checks.push({
          label: 'Source-intelligence host',
          status: 'warn',
          detail: 'not configured',
          next: 'run `horus index` to analyze this repo and start a host, or pass --axon <url> to `horus init`',
        });
      }
    } catch {
      checks.push({
        label: 'Source-intelligence host',
        status: 'warn',
        detail: 'could not read local config',
        next: 'run `horus init` to recreate .horus/config.json for this repo',
      });
    }
  } else {
    checks.push({
      label: 'Local config',
      status: 'warn',
      detail: '.horus/config.json not found',
      next: 'run `horus init` to create one for this repo',
    });
    checks.push({
      label: 'Source-intelligence host',
      status: 'warn',
      detail: 'not configured (no local config)',
      next: 'run `horus init` then `horus index` to set up source intelligence',
    });
  }

  // Database check — probe Postgres for reachability and schema readiness.
  {
    const dbChecker = opts?._dbCheck ?? checkDatabase;
    let dbUrl = process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
    let globalConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
    try {
      globalConfig = await loadConfig(opts?.config, { cwd });
      dbUrl = globalConfig.database.url;
    } catch {
      // No global config — use env var or default URL
    }

    const db = await dbChecker(dbUrl);
    if (!db.reachable) {
      checks.push({
        label: 'Database',
        status: 'warn',
        detail: 'Postgres not reachable',
        next:
          'start a local instance:\n' +
          '      docker run -d --name horus-db \\\n' +
          '        -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n' +
          '        -p 5433:5432 postgres:16\n' +
          '    or set DATABASE_URL to an existing Postgres 16 instance',
      });
    } else if (!db.schemaReady) {
      checks.push({
        label: 'Database',
        status: 'warn',
        detail: 'connected but schema not applied',
        next: 'run migrations: pnpm db migrate',
      });
    } else {
      checks.push({
        label: 'Database',
        status: 'pass',
        detail: db.schemaDetail,
      });
    }
  }

  // Runtime connector checks — all connector types resolved in one config pass.
  try {
    const globalConfig = await loadConfig(opts?.config, { cwd });
    let anyEs = false;
    let anyGrafana = false;
    let anyMongo = false;
    let anyRedis = false;

    for (const project of globalConfig.projects) {
      for (const env of project.environments) {
        const ctx = `${project.name}/${env.name}`;
        const c = env.connectors;

        // Elasticsearch
        if (c.elasticsearch) {
          anyEs = true;
          if (!c.elasticsearch.indexPattern) {
            checks.push({
              label: 'Elasticsearch',
              status: 'warn',
              detail: `${ctx} — indexPattern not set`,
              next: 'set indexPattern in connectors.elasticsearch',
            });
          } else {
            checks.push({
              label: 'Elasticsearch',
              status: 'pass',
              detail: `${ctx} — ${c.elasticsearch.indexPattern} [runtime ingestion pending]`,
            });
          }
        }

        // Grafana (metrics)
        if (c.grafana) {
          anyGrafana = true;
          if (!c.grafana.url) {
            checks.push({
              label: 'Grafana',
              status: 'warn',
              detail: `${ctx} — URL not set`,
              next: 'set grafana.url or grafana.urlEnv in your Horus config',
            });
          } else {
            const dashHint = c.grafana.dashboard ? ` (${c.grafana.dashboard})` : '';
            checks.push({
              label: 'Grafana',
              status: 'pass',
              detail: `${ctx} — URL configured${dashHint} [runtime ingestion pending]`,
            });
          }
        }

        // MongoDB (state)
        if (c.mongodb) {
          anyMongo = true;
          if (!c.mongodb.url) {
            checks.push({
              label: 'MongoDB',
              status: 'warn',
              detail: `${ctx} — URL not set`,
              next: 'set mongodb.url or mongodb.urlEnv in your Horus config',
            });
          } else {
            checks.push({
              label: 'MongoDB',
              status: 'pass',
              detail: `${ctx} — ${c.mongodb.database} [runtime ingestion pending]`,
            });
          }
        }

        // Redis / BullMQ (queue state)
        if (c.redis) {
          anyRedis = true;
          if (!c.redis.url) {
            checks.push({
              label: 'Redis',
              status: 'warn',
              detail: `${ctx} — URL not set`,
              next: 'set redis.url or redis.urlEnv in your Horus config',
            });
          } else {
            checks.push({
              label: 'Redis',
              status: 'pass',
              detail: `${ctx} — URL configured [runtime ingestion pending]`,
            });
          }
        }
      }
    }

    if (!anyEs) {
      checks.push({
        label: 'Elasticsearch',
        status: 'warn',
        detail: 'not configured',
        next: 'add connectors.elasticsearch to an environment in your Horus config for runtime log evidence',
      });
    }
    if (!anyGrafana) {
      checks.push({
        label: 'Grafana',
        status: 'warn',
        detail: 'not configured',
        next: 'add connectors.grafana to an environment for metric evidence',
      });
    }
    if (!anyMongo) {
      checks.push({
        label: 'MongoDB',
        status: 'warn',
        detail: 'not configured',
        next: 'add connectors.mongodb to an environment for database state evidence',
      });
    }
    if (!anyRedis) {
      checks.push({
        label: 'Redis',
        status: 'warn',
        detail: 'not configured',
        next: 'add connectors.redis to an environment for queue state evidence',
      });
    }
  } catch {
    // No global config loadable — skip connector checks silently.
  }

  write(pc.bold('\nHorus readiness check\n'));
  let hasFailure = false;
  for (const check of checks) {
    write(`  ${mark(check.status)} ${pc.bold(check.label.padEnd(26))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`    ${pc.dim('→ ' + check.next)}`);
    }
    if (check.status === 'fail') hasFailure = true;
  }
  write('');

  return hasFailure ? 1 : 0;
}
