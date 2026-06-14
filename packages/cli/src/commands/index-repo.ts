/**
 * `horus index` — build the queue map for a project (HOR-6), and (HOR-37) make it
 * the one-command setup: auto-detect the repo, ensure Axon has analyzed + is
 * hosting it, stitch the queue boundaries, and write/register a `.horus/config.json`.
 *
 * Two modes:
 *   1. An already-configured project (central config or --name/--project) whose Axon
 *      host is healthy → just (re)build the queue map.
 *   2. Otherwise auto-detect the repo in cwd → ensure `axon analyze` + `axon host`
 *      → stitch → write `.horus/config.json` + register the project.
 */

import { basename } from 'node:path';
import pc from 'picocolors';
import {
  loadConfig,
  resolveEnvironment,
  findRepoRoot,
  discoverLocalConfig,
  readLocalConfig,
  writeLocalConfig,
  registerProject,
  type LocalConfigFile,
} from '@horus/core';
import {
  AxonHttpClient,
  axonAvailable,
  isAnalyzed,
  analyzeRepo,
  isHostHealthy,
  findFreePort,
  startHost,
  waitForHost,
} from '@horus/connectors';
import { createDb } from '@horus/db';
import { stitch } from '@horus/stitcher';

async function stitchQueueMap(hostUrl: string, dbUrl: string, label: string): Promise<void> {
  const axon = new AxonHttpClient({ baseUrl: hostUrl });
  const { db, sql } = createDb(dbUrl);
  try {
    const summary = await stitch(axon, db);
    console.log(
      pc.dim(`[${label}]  `) +
        `Stitched ${summary.edges} queue edge(s) across ${summary.queues} queue(s) — ` +
        `${summary.producers} producer(s), ${summary.workers} worker(s).`,
    );
  } finally {
    await sql.end();
  }
}

export async function runIndex(opts: {
  config?: string;
  name?: string;
  project?: string;
  env?: string;
}): Promise<number> {
  try {
    const cwd = process.cwd();
    const dbUrlDefault =
      process.env['DATABASE_URL'] ?? 'postgresql://horus:horus@localhost:5433/horus';

    // --- Mode 1: an existing, resolvable project with a healthy host ---
    let resolvedDbUrl = dbUrlDefault;
    try {
      const config = await loadConfig(opts.config, { name: opts.name });
      resolvedDbUrl = config.database.url;
      const renv = resolveEnvironment(config, { project: opts.project, env: opts.env });
      const existingHost = renv.repositories[0]?.axonHostUrl;
      if (existingHost && (await isHostHealthy(existingHost))) {
        await stitchQueueMap(existingHost, config.database.url, `${renv.project}/${renv.env}`);
        return 0;
      }
    } catch {
      // No resolvable config (or host down) — fall through to auto-detect setup.
    }

    // --- Mode 2: auto-detect + Axon lifecycle ---
    const root = findRepoRoot(cwd) ?? cwd;

    // Reuse an existing local name if this repo was indexed before.
    const localPath = discoverLocalConfig(root);
    let existingName: string | undefined;
    let existingHostUrl: string | undefined;
    if (localPath !== null) {
      try {
        const file = readLocalConfig(localPath);
        const proj = file.project as { name?: string; repositories?: Array<{ axon?: { hostUrl?: string } }> };
        existingName = proj.name;
        existingHostUrl = proj.repositories?.[0]?.axon?.hostUrl;
      } catch {
        // ignore a malformed local config
      }
    }
    const name = opts.name ?? existingName ?? basename(root);

    console.log(pc.bold(`Indexing ${name}`) + pc.dim(`  (${root})`));

    if (!(await axonAvailable())) {
      console.error(
        pc.red('`axon` not found on PATH. Install it (see `horus setup`) and retry.'),
      );
      return 1;
    }

    // 1. Ensure the repo is analyzed.
    if (!isAnalyzed(root)) {
      console.log(pc.dim('  analyzing with Axon (first time — this can take a while)…'));
      try {
        await analyzeRepo(root);
      } catch (err) {
        console.error(pc.red(`  axon analyze failed: ${(err as Error).message}`));
        return 1;
      }
    } else {
      console.log(pc.dim('  already analyzed (.axon present)'));
    }

    // 2. Ensure a host is running.
    let hostUrl = existingHostUrl;
    if (hostUrl && (await isHostHealthy(hostUrl))) {
      console.log(pc.dim(`  reusing Axon host at ${hostUrl}`));
    } else {
      const port = await findFreePort();
      hostUrl = `http://127.0.0.1:${port}`;
      console.log(pc.dim(`  starting Axon host on port ${port}…`));
      startHost(root, port);
      if (!(await waitForHost(hostUrl))) {
        console.error(
          pc.red(`  Axon host did not become healthy — see ${root}/.horus/axon-host.log`),
        );
        return 1;
      }
    }

    // 3. Build the queue map.
    await stitchQueueMap(hostUrl, resolvedDbUrl, name);

    // 4. Write/register the local project config.
    const file: LocalConfigFile = {
      version: 1,
      project: {
        name,
        repositories: [{ name, path: root, axon: { hostUrl } }],
        environments: [{ name: opts.env ?? 'production', readOnly: true, connectors: {} }],
      },
    };
    const configPath = writeLocalConfig(root, file);
    registerProject(name, root, configPath);

    console.log(`${pc.green('✓')} Indexed ${pc.bold(name)} — host ${hostUrl}`);
    console.log(pc.dim(`  ${configPath}`));
    console.log(pc.dim(`  investigate: horus investigate --name ${name} "<hint>"  (or from this repo, just \`horus investigate "<hint>"\`)`));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}
