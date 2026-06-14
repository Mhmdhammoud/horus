import pc from 'picocolors';
import {
  HORUS_VERSION,
  PINNED_AXON_VERSION,
  loadConfig,
  type HorusConfig,
} from '@horus/core';
import { AxonHttpClient, checkAxonCompatibility } from '@horus/connectors';
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

export async function runStatus(configPath?: string): Promise<number> {
  console.log(pc.bold(`\nHorus ${HORUS_VERSION}`));
  console.log(pc.dim(`pinned Axon: ${PINNED_AXON_VERSION} · transport: HTTP/MCP only\n`));

  let config: HorusConfig | undefined;
  const checks: Check[] = [];

  try {
    config = await loadConfig(configPath);
    checks.push({ label: 'Config', ok: true, detail: 'loaded & valid' });
  } catch (err) {
    checks.push({
      label: 'Config',
      ok: false,
      detail: (err as Error).message,
      fatal: true,
    });
  }

  if (config) {
    const repoSummary =
      config.repos.length > 0
        ? config.repos.map((r) => r.name).join(', ')
        : pc.dim('none configured');
    checks.push({ label: 'Repos', ok: 'pending', detail: repoSummary });

    const axonUrl = config.axon.hostUrl;
    const dbUrl = config.database.url;

    const axon = new AxonHttpClient({ baseUrl: axonUrl });

    const [health, compat, h] = await Promise.all([
      axon.health(),
      checkAxonCompatibility(axon),
      checkDatabase(dbUrl),
    ]);

    let versionPart: string;
    if (compat.version === null) {
      versionPart = 'version unknown';
    } else if (compat.matches) {
      versionPart = `v${compat.version} (pinned ✓)`;
    } else {
      versionPart = `v${compat.version} (pinned ${compat.pinned} — MISMATCH)`;
    }

    checks.push({
      label: 'Axon',
      ok: health.ok,
      detail: health.ok
        ? `responded ${health.status} · ${versionPart} at ${axonUrl}`
        : `unreachable — run 'axon host --port 8420' (${axonUrl})`,
    });

    checks.push({
      label: 'Postgres',
      ok: h.reachable,
      detail: h.reachableDetail,
    });

    checks.push({
      label: 'Schema',
      ok: h.schemaReady,
      detail: h.schemaDetail,
    });
  }

  for (const c of checks) {
    console.log(`  ${mark(c.ok)} ${pc.bold(c.label)}  ${pc.dim(c.detail)}`);
  }
  console.log('');

  // Exit non-zero only on a fatal failure (bad config). Unreachable Axon host,
  // Postgres, or unmigrated schema are warnings — not fatal.
  return checks.some((c) => c.ok === false && c.fatal) ? 1 : 0;
}
