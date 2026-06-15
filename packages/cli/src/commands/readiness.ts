/**
 * HOR-97 — Release readiness summary command.
 *
 * Reports whether the local checkout is ready for a demo or preview release.
 * Checks are split into two tiers:
 *
 *   Blocking  — must pass before any demo or release (DB reachability/schema,
 *               CLI binary present). Non-zero exit code when any blocking check fails.
 *   Optional  — improve investigation depth but do not block a basic demo
 *               (source intelligence, local config, connectors, indexed repo).
 *
 * Does not auto-start services, run investigation flows, or probe live
 * external connectors (Elasticsearch, Grafana, MongoDB, Redis).
 */

import pc from 'picocolors';
import {
  HORUS_VERSION,
  discoverLocalConfig,
  loadConfig,
  PINNED_SOURCE_VERSION,
} from '@horus/core';
import { checkDatabase, type DbHealth } from '@horus/db';
import { getSourceVersion } from '@horus/connectors';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

type ReadinessStatus = 'pass' | 'warn' | 'fail';

interface ReadinessCheck {
  label: string;
  status: ReadinessStatus;
  /** true = must pass for release/demo; false = optional. */
  blocking: boolean;
  detail: string;
  next?: string;
}

function mark(status: ReadinessStatus): string {
  if (status === 'pass') return pc.green('✓');
  if (status === 'warn') return pc.yellow('~');
  return pc.red('✗');
}

export async function runReadiness(opts?: {
  cwd?: string;
  config?: string;
  write?: (line: string) => void;
  /** Injectable for tests — defaults to the real checkDatabase. */
  _dbCheck?: (url: string) => Promise<DbHealth>;
  /** Injectable for tests — defaults to the real getSourceVersion. */
  _sourceVersion?: () => Promise<string | null>;
  /** Injectable for tests — defaults to the real loadConfig. */
  _loadConfig?: typeof loadConfig;
}): Promise<number> {
  const cwd = opts?.cwd ?? process.cwd();
  const write = opts?.write ?? ((line: string) => console.log(line));
  const dbChecker = opts?._dbCheck ?? checkDatabase;
  const sourceVersionFn = opts?._sourceVersion ?? getSourceVersion;
  const configLoader = opts?._loadConfig ?? loadConfig;
  const checks: ReadinessCheck[] = [];

  // ── CLI binary — always passes if the process is running ─────────────────
  checks.push({
    label: 'CLI',
    status: 'pass',
    blocking: true,
    detail: `horus ${HORUS_VERSION}`,
  });

  // ── Load global config once (used for DB URL + connector checks) ──────────
  let globalConfig: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    globalConfig = await configLoader(opts?.config, { cwd });
  } catch {
    // No global config — DB URL falls back to env or default.
  }

  // ── Database — BLOCKING ───────────────────────────────────────────────────
  const dbUrl = globalConfig?.database.url ?? process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  const db = await dbChecker(dbUrl);
  if (!db.reachable) {
    checks.push({
      label: 'Database',
      status: 'fail',
      blocking: true,
      detail: 'Postgres not reachable',
      next:
        'docker run -d --name horus-db \\\n' +
        '        -e POSTGRES_USER=horus -e POSTGRES_PASSWORD=horus -e POSTGRES_DB=horus \\\n' +
        '        -p 5433:5432 postgres:16\n' +
        '      or set DATABASE_URL to an existing Postgres 16 instance',
    });
  } else if (!db.schemaReady) {
    checks.push({
      label: 'Database',
      status: 'fail',
      blocking: true,
      detail: 'connected but schema not applied',
      next: 'pnpm db migrate',
    });
  } else {
    checks.push({
      label: 'Database',
      status: 'pass',
      blocking: true,
      detail: db.schemaDetail,
    });
  }

  // ── Local config (.horus/config.json) — OPTIONAL ─────────────────────────
  const localConfigPath = discoverLocalConfig(cwd);
  checks.push(
    localConfigPath
      ? { label: 'Local config', status: 'pass', blocking: false, detail: localConfigPath }
      : {
          label: 'Local config',
          status: 'warn',
          blocking: false,
          detail: '.horus/config.json not found',
          next: 'run `horus init` to create one for this repo',
        },
  );

  // ── Source-intelligence backend — OPTIONAL ────────────────────────────────
  const sourceVersion = await sourceVersionFn();
  if (sourceVersion === null) {
    checks.push({
      label: 'Source intelligence',
      status: 'warn',
      blocking: false,
      detail: 'not installed — source intelligence unavailable',
      next: `uv tool install axoniq==${PINNED_SOURCE_VERSION}`,
    });
  } else if (sourceVersion !== PINNED_SOURCE_VERSION) {
    checks.push({
      label: 'Source intelligence',
      status: 'warn',
      blocking: false,
      detail: `version mismatch (installed: ${sourceVersion}, required: ${PINNED_SOURCE_VERSION})`,
      next: `uv tool install axoniq==${PINNED_SOURCE_VERSION}`,
    });
  } else {
    checks.push({
      label: 'Source intelligence',
      status: 'pass',
      blocking: false,
      detail: `${sourceVersion} — ready`,
    });
  }

  // ── Connector config (from global config) — OPTIONAL ─────────────────────
  if (!globalConfig) {
    checks.push({
      label: 'Global config',
      status: 'warn',
      blocking: false,
      detail: 'horus.config.js not found — connector and repo checks skipped',
      next: 'run `horus generate-config` then fill in your project details',
    });
  } else {
    let anyRepoConfigured = false;
    let anyEs = false;
    let anyGrafana = false;
    let anyMongo = false;
    let anyRedis = false;

    for (const project of globalConfig.projects) {
      for (const repo of project.repositories) {
        if (repo.source?.hostUrl ?? repo.axon?.hostUrl) anyRepoConfigured = true;
      }
      for (const env of project.environments) {
        const c = env.connectors;
        if (c.elasticsearch) anyEs = true;
        if (c.grafana) anyGrafana = true;
        if (c.mongodb) anyMongo = true;
        if (c.redis) anyRedis = true;
      }
    }

    checks.push(
      anyRepoConfigured
        ? { label: 'Source host', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Source host',
            status: 'warn',
            blocking: false,
            detail: 'no source host URL in any project',
            next: 'set source.hostUrl in horus.config.js for this repository',
          },
    );

    checks.push(
      anyEs
        ? { label: 'Elasticsearch', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Elasticsearch',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no runtime log evidence',
            next: 'run `horus connect elasticsearch`',
          },
    );

    checks.push(
      anyGrafana
        ? { label: 'Grafana', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Grafana',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no metric evidence',
            next: 'run `horus connect grafana`',
          },
    );

    checks.push(
      anyMongo
        ? { label: 'MongoDB', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'MongoDB',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no database state evidence',
            next: 'run `horus connect mongodb`',
          },
    );

    checks.push(
      anyRedis
        ? { label: 'Redis', status: 'pass', blocking: false, detail: 'configured' }
        : {
            label: 'Redis',
            status: 'warn',
            blocking: false,
            detail: 'not configured — no queue state evidence',
            next: 'run `horus connect redis`',
          },
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const blockingChecks = checks.filter(c => c.blocking);
  const optionalChecks = checks.filter(c => !c.blocking);

  write(pc.bold('\nHorus release readiness\n'));

  write(pc.bold('  Blocking'));
  for (const check of blockingChecks) {
    write(`    ${mark(check.status)} ${pc.bold(check.label.padEnd(22))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`      ${pc.dim('→ ' + check.next)}`);
    }
  }

  write('');
  write(pc.bold('  Optional'));
  for (const check of optionalChecks) {
    write(`    ${mark(check.status)} ${pc.bold(check.label.padEnd(22))}  ${pc.dim(check.detail)}`);
    if (check.next) {
      write(`      ${pc.dim('→ ' + check.next)}`);
    }
  }

  write('');

  const blockingFails = blockingChecks.filter(c => c.status === 'fail');
  const optionalWarns = optionalChecks.filter(c => c.status === 'warn').length;

  if (blockingFails.length === 0) {
    if (optionalWarns === 0) {
      write(pc.green('  Ready for demo/release.'));
    } else {
      write(
        pc.yellow(
          `  Ready for a basic demo. ${optionalWarns} optional item(s) not configured — investigation evidence will be limited.`,
        ),
      );
    }
  } else {
    write(
      pc.red(
        `  Not ready. ${blockingFails.length} blocking item(s) must be resolved before demo/release.`,
      ),
    );
    write(pc.dim('  Re-run `horus readiness` after resolving the items above.'));
  }

  write('');
  return blockingFails.length > 0 ? 1 : 0;
}
