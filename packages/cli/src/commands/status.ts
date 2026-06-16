import pc from 'picocolors';
import {
  HORUS_VERSION,
  PINNED_SOURCE_VERSION,
  loadConfig,
  listEnvironments,
  resolveEnvironment,
  type HorusConfig,
  type ResolvedEnvironment,
} from '@horus/core';
import {
  SourceHttpClient,
  checkSourceCompatibility,
  codeForEnv,
  logsForEnv,
  metricsForEnv,
} from '@horus/connectors';
import { checkDatabase } from '@horus/db';

interface Check {
  label: string;
  ok: boolean | 'pending';
  detail: string;
  /** A failed `fatal` check sets a non-zero exit code; non-fatal failures are warnings. */
  fatal?: boolean;
}

function mark(ok: boolean | 'pending'): string {
  if (ok === 'pending') return pc.yellow('○');
  return ok ? pc.green('●') : pc.red('●');
}

/** Print health status for one resolved environment. Returns true when healthy. */
async function checkEnv(renv: ResolvedEnvironment): Promise<boolean> {
  const header =
    `  ${pc.bold(renv.project)} / ${pc.bold(renv.env)}` +
    (renv.readOnly ? pc.dim('  (read-only)') : '');
  console.log(header);

  let allOk = true;

  // Axon — code intelligence, belongs to the project's repositories.
  if (renv.repositories.length === 0) {
    console.log(`    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim('no repositories configured')}`);
  }
  for (const repo of renv.repositories) {
    const axonHostUrl = repo.sourceHostUrl ?? repo.axonHostUrl;
    if (!axonHostUrl) {
      console.log(
        `    ${mark('pending')} ${pc.bold('Source')}          ${pc.dim(`${repo.name}: not configured`)}`,
      );
      continue;
    }
    const axon = new SourceHttpClient({ baseUrl: axonHostUrl });
    const [health, compat] = await Promise.all([
      axon.health(),
      checkSourceCompatibility(axon),
    ]);

    let versionPart: string;
    if (compat.version === null) {
      versionPart = 'version unknown';
    } else if (compat.matches) {
      versionPart = `v${compat.version} (pinned ✓)`;
    } else {
      versionPart = `v${compat.version} (pinned ${compat.pinned} — MISMATCH)`;
    }

    const axonDetail = health.ok
      ? `${repo.name} · responded ${health.status} · ${versionPart} at ${axonHostUrl}`
      : `${repo.name} · unreachable at ${axonHostUrl}`;
    console.log(`    ${mark(health.ok)} ${pc.bold('Source')}          ${pc.dim(axonDetail)}`);
    if (!health.ok) allOk = false;
  }

  // Elasticsearch
  const esCfg = renv.connectors.elasticsearch;
  if (esCfg) {
    const logsProvider = logsForEnv(renv);
    if (logsProvider) {
      const h = await logsProvider.health();
      const idxDisplay = esCfg.indexPatterns ? esCfg.indexPatterns.join(', ') : esCfg.indexPattern;
      const detail = h.ok
        ? `reachable · index ${idxDisplay}`
        : `unreachable · index ${idxDisplay}`;
      console.log(`    ${mark(h.ok)} ${pc.bold('Elasticsearch')}   ${pc.dim(detail)}`);
      if (!h.ok) allOk = false;
    } else {
      const idxDisplay = esCfg.indexPatterns ? esCfg.indexPatterns.join(', ') : esCfg.indexPattern;
      console.log(
        `    ${mark(false)} ${pc.bold('Elasticsearch')}   ${pc.dim(`configured (index ${idxDisplay}) but ES_URL not set`)}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Elasticsearch')}   ${pc.dim('not configured')}`,
    );
  }

  // Grafana
  const grafanaCfg = renv.connectors.grafana;
  if (grafanaCfg) {
    const metricsProvider = metricsForEnv(renv);
    if (metricsProvider) {
      const h = await metricsProvider.health();
      const dashDisplay = grafanaCfg.dashboards
        ? grafanaCfg.dashboards.join(', ')
        : grafanaCfg.dashboard;
      const dashSuffix = dashDisplay ? ` · dashboards: ${dashDisplay}` : '';
      const detail = h.ok ? `reachable${dashSuffix}` : `unreachable${dashSuffix}`;
      console.log(`    ${mark(h.ok)} ${pc.bold('Grafana')}         ${pc.dim(detail)}`);
      if (!h.ok) allOk = false;
    } else {
      console.log(
        `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim('configured but GRAFANA_URL not set')}`,
      );
    }
  } else {
    console.log(
      `    ${mark('pending')} ${pc.bold('Grafana')}         ${pc.dim('not configured')}`,
    );
  }

  // MongoDB
  const mongoCfg = renv.connectors.mongodb;
  if (mongoCfg) {
    const collCount = mongoCfg.collections.length;
    const detail =
      `configured: db ${mongoCfg.database}, ${collCount} collection(s)` +
      pc.dim(' (provider: HOR-33)');
    console.log(`    ${mark('pending')} ${pc.bold('MongoDB')}         ${pc.dim(detail)}`);
  } else {
    console.log(`    ${mark('pending')} ${pc.bold('MongoDB')}         ${pc.dim('not configured')}`);
  }

  // Redis
  const redisCfg = renv.connectors.redis;
  if (redisCfg?.url) {
    const safeUrl = redactRedisUrl(redisCfg.url);
    console.log(`    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim(`configured · ${safeUrl}`)}`);
  } else {
    console.log(`    ${mark('pending')} ${pc.bold('Redis')}           ${pc.dim('not configured')}`);
  }

  console.log('');
  return allOk;
}

/** Mask password in a Redis URL for safe display. */
function redactRedisUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) {
      u.password = '***';
    }
    if (u.username) {
      u.username = u.username === '' ? '' : '***';
    }
    return u.toString();
  } catch {
    return raw.replace(/\/\/:?[^@]*@/, '//:***@');
  }
}

export async function runStatus(
  configPath?: string,
  opts?: { name?: string; project?: string; env?: string },
): Promise<number> {
  console.log(pc.bold(`\nHorus ${HORUS_VERSION}`));
  console.log(pc.dim(`pinned backend: ${PINNED_SOURCE_VERSION} · transport: HTTP/MCP only\n`));

  let config: HorusConfig | undefined;
  const checks: Check[] = [];

  try {
    config = await loadConfig(configPath, { name: opts?.name });
    checks.push({ label: 'Config', ok: true, detail: 'loaded & valid' });
  } catch (err) {
    checks.push({
      label: 'Config',
      ok: false,
      detail: (err as Error).message,
      fatal: true,
    });
  }

  // Print config check before going further
  for (const c of checks) {
    console.log(`  ${mark(c.ok)} ${pc.bold(c.label)}  ${pc.dim(c.detail)}`);
  }

  if (!config) {
    console.log('');
    return 1;
  }

  // --- Postgres (always shown, not project-scoped) ---
  const dbUrl = config.database.url;
  const h = await checkDatabase(dbUrl);
  console.log(`  ${mark(h.reachable)} ${pc.bold('Postgres')}  ${pc.dim(h.reachableDetail)}`);
  console.log(`  ${mark(h.schemaReady)} ${pc.bold('Schema')}    ${pc.dim(h.schemaDetail)}`);
  console.log('');

  // --- Project / environment matrix ---
  const envList = listEnvironments(config);
  if (envList.length === 0) {
    console.log(pc.dim('  No projects configured.\n'));
    return 0;
  }

  if (opts?.project !== undefined || opts?.env !== undefined) {
    // Focused: single env
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 1;
    }
    const ok = await checkEnv(renv);
    return ok ? 0 : 1;
  }

  // Matrix: all environments
  let allHealthy = true;
  for (const { project, env } of envList) {
    let renv: ResolvedEnvironment;
    try {
      renv = resolveEnvironment(config, { project, env });
    } catch (err) {
      console.error(pc.red(`  ${project}/${env}: ${(err as Error).message}`));
      allHealthy = false;
      continue;
    }
    const ok = await checkEnv(renv);
    if (!ok) allHealthy = false;
  }

  // Exit non-zero only on a fatal failure (bad config). Unreachable providers are
  // warnings in matrix mode; exit 1 only when --project/--env was given.
  return checks.some((c) => c.ok === false && c.fatal) ? 1 : 0;
}
