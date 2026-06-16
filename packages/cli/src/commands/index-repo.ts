/**
 * `horus index` — build the queue map for a project (HOR-6), and (HOR-37) make it
 * the one-command setup: auto-detect the repo, ensure horus-source is hosting it,
 * stitch the queue boundaries, and (for new repos) write/register a `.horus/config.json`.
 *
 * Host model: horus-source runs at most ONE host per repo (single-writer Kùzu lock),
 * but different repos run their own hosts on their own ports concurrently. So `horus
 * index` NEVER starts a second host for a repo that already has one — it reuses it
 * (from the resolved config, or from `.horus/source/host.json`).
 */

import { basename, resolve } from 'node:path';
import pc from 'picocolors';
import {
  loadConfig,
  resolveEnvironment,
  findRepoRoot,
  writeLocalConfig,
  registerProject,
  discoverLocalConfig,
  readLocalConfig,
  type HorusConfig,
  type LocalConfigFile,
} from '@horus/core';
import {
  SourceHttpClient,
  sourceAvailable,
  isAnalyzed,
  analyzeRepo,
  isHostHealthy,
  readSourceHostUrl,
  findFreePort,
  startHost,
  waitForHost,
  removeSpawnedHostRecord,
} from '@horus/connectors';
import { createDb } from '@horus/db';
import { stitch } from '@horus/stitcher';

async function stitchQueueMap(hostUrl: string, dbUrl: string, label: string): Promise<void> {
  const axon = new SourceHttpClient({ baseUrl: hostUrl });
  const { db, sql } = createDb(dbUrl);
  try {
    const summary = await stitch(axon, db, { project: label });
    console.log(
      pc.dim(`[${label}]  `) +
        `Stitched ${summary.edges} queue edge(s) across ${summary.queues} queue(s) — ` +
        `${summary.producers} producer(s), ${summary.workers} worker(s).`,
    );
  } finally {
    await sql.end();
  }
}

/** Find a project in the config whose repository path matches `root`. */
function findConfiguredRepo(
  config: HorusConfig,
  root: string,
): { project: string; hostUrl?: string } | null {
  const target = resolve(root);
  for (const p of config.projects) {
    for (const r of p.repositories) {
      if (resolve(r.path) === target) {
        const hostUrl = r.source?.hostUrl ?? r.axon?.hostUrl;
        return { project: p.name, ...(hostUrl ? { hostUrl } : {}) };
      }
    }
  }
  return null;
}

export async function runIndex(opts: {
  config?: string;
  name?: string;
  project?: string;
  env?: string;
}): Promise<number> {
  try {
    const cwd = process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const dbUrlDefault =
      process.env['DATABASE_URL'] ?? 'postgresql://horus:horus@localhost:5433/horus';

    // Try to resolve a config (central, .horus, or --name). Non-fatal if absent.
    let config: HorusConfig | null = null;
    try {
      config = await loadConfig(opts.config, { name: opts.name });
    } catch {
      config = null;
    }
    const dbUrl = config?.database.url ?? dbUrlDefault;

    // Is this repo already a configured project? Either explicitly (--project/--name)
    // or by matching its path in the config. If so, we reuse its host and do NOT write
    // a local .horus (that would shadow the project's runtime connectors).
    let configuredProject: string | null = null;
    let configuredHost: string | undefined;
    if (config) {
      if (opts.project !== undefined || opts.name !== undefined) {
        try {
          const renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
          configuredProject = renv.project;
          configuredHost = renv.repositories[0]?.sourceHostUrl ?? renv.repositories[0]?.axonHostUrl;
        } catch {
          /* fall through to path match */
        }
      }
      if (configuredProject === null) {
        const match = findConfiguredRepo(config, root);
        if (match) {
          configuredProject = match.project;
          configuredHost = match.hostUrl;
        }
      }
    }

    const isConfigured = configuredProject !== null;
    const name = opts.name ?? configuredProject ?? basename(root);
    const label = configuredProject ?? name;

    // Resolve a healthy host WITHOUT ever double-starting one for this repo.
    // Candidates in priority: the configured host, then the host recorded in host.json.
    let hostUrl: string | undefined;
    let spawned = false;
    for (const candidate of [configuredHost, readSourceHostUrl(root) ?? undefined]) {
      if (candidate && (await isHostHealthy(candidate))) {
        hostUrl = candidate;
        break;
      }
    }

    if (hostUrl) {
      console.log(pc.dim(`Reusing source-intelligence host for ${label} at ${hostUrl}`));
    } else {
      spawned = true;
      // No host running for this repo — set one up.
      console.log(pc.bold(`Indexing ${label}`) + pc.dim(`  (${root})`));
      if (!(await sourceAvailable())) {
        console.error(pc.red('horus-source not found on PATH. Install it: pip install horus-source'));
        return 1;
      }
      if (!isAnalyzed(root)) {
        console.log(pc.dim('  analyzing with source-intelligence backend (first time — this can take a while)…'));
        try {
          await analyzeRepo(root);
        } catch (err) {
          console.error(pc.red(`  source analysis failed: ${(err as Error).message}`));
          return 1;
        }
      } else {
        console.log(pc.dim('  already analyzed'));
      }
      const port = await findFreePort();
      hostUrl = `http://127.0.0.1:${port}`;
      console.log(pc.dim(`  starting source-intelligence host on port ${port}…`));
      startHost(root, port);
      if (!(await waitForHost(hostUrl))) {
        // Remove the ownership record — the host never became healthy, so the
        // record would cause `horus stop` to try to signal a dead process.
        removeSpawnedHostRecord(root);
        console.error(
          pc.red(`  Source-intelligence host did not become healthy — see ${root}/.horus/source-host.log`),
        );
        return 1;
      }
    }

    // Build the queue map.
    await stitchQueueMap(hostUrl, dbUrl, label);

    if (spawned && !isConfigured) {
      // Brand new repo — write a full local config and register it.
      const file: LocalConfigFile = {
        version: 1,
        project: {
          name,
          repositories: [{ name, path: root, source: { hostUrl } }],
          environments: [{ name: opts.env ?? 'production', readOnly: true, connectors: {} }],
        },
      };
      const configPath = writeLocalConfig(root, file);
      registerProject(name, root, configPath);
      console.log(`${pc.green('✓')} Indexed ${pc.bold(name)} — host ${hostUrl}`);
      console.log(pc.dim(`  ${configPath}`));
      console.log(
        pc.dim(
          `  investigate: horus investigate --name ${name} "<hint>"  (or from this repo: horus investigate "<hint>")`,
        ),
      );
    } else if (spawned && !configuredHost) {
      // Config exists (e.g. from `horus init`) but had no source host set.
      // Patch the first repository entry with the newly started host URL so that
      // `doctor`, `investigate`, and other source-backed commands find it.
      const existingPath = discoverLocalConfig(root);
      if (existingPath) {
        const file = readLocalConfig(existingPath);
        const project = file.project as Record<string, unknown>;
        const repos = project['repositories'] as Array<Record<string, unknown>> | undefined;
        if (repos && repos.length > 0) {
          repos[0]!['source'] = { hostUrl };
        }
        writeLocalConfig(root, file);
        registerProject(label, root, existingPath);
        console.log(`${pc.green('✓')} Indexed ${pc.bold(label)} — source host registered at ${hostUrl}`);
        console.log(pc.dim(`  ${existingPath}`));
      } else {
        console.log(`${pc.green('✓')} Indexed ${pc.bold(label)} ${pc.dim('(queue map refreshed)')}`);
      }
    } else {
      console.log(
        `${pc.green('✓')} Indexed ${pc.bold(label)} ${pc.dim('(queue map refreshed)')}`,
      );
    }
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
