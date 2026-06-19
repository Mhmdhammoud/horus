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
  ensureProjectGitignore,
  getHeadSha,
  getCurrentBranch,
  collectLocalChanges,
  type HorusConfig,
  type LocalConfigFile,
} from '@horus/core';
import {
  buildProjectKnowledge,
  createJsonKnowledgeStore,
  importKnowledgeBaseFile,
  type RepoInput,
} from '@horus/knowledge';
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

export interface IndexOptions {
  config?: string;
  name?: string;
  project?: string;
  env?: string;
  /** Build a full project-knowledge snapshot (default mode). */
  full?: boolean;
  /** Pre-push-safe mode: only changed files, avoid heavy re-indexing. */
  changed?: boolean;
  /** Speed hint, used with --changed. */
  fast?: boolean;
  /** Import a Maison Safqa knowledge-base JSON instead of deriving from source. */
  importKb?: string;
}

/**
 * Additive project-knowledge pass (HOR-293). Best-effort: never fails `horus index`.
 * `--changed --fast` is the pre-push-safe path (cheap landscape refresh + changed-file
 * awareness); `--full` rebuilds the landscape. Deeper per-file extraction (contracts,
 * types, data flows) layers on top later using the changed-file set.
 */
function buildKnowledgeIndex(
  root: string,
  config: HorusConfig | null,
  label: string,
  configuredProject: string | null,
  opts: IndexOptions,
): void {
  try {
    const gitSha = getHeadSha(root) ?? undefined;
    const branch = getCurrentBranch(root) ?? undefined;

    // Import mode: a provided KB is the knowledge source (HOR-292).
    if (opts.importKb) {
      const res = importKnowledgeBaseFile(resolve(opts.importKb), { root, project: label });
      const total = res.manifest ? Object.values(res.manifest.counts).reduce((a, b) => a + b, 0) : 0;
      console.log(pc.dim(`  project knowledge: imported ${total} item(s) from ${opts.importKb}`));
      if (res.warnings.length) console.log(pc.dim(`  (${res.warnings.length} import warning(s))`));
      return;
    }

    const changedMode = opts.changed === true && opts.full !== true;
    if (changedMode) {
      // Pre-push-safe: note what changed (future per-file extraction will use this),
      // but keep the build to the cheap landscape pass.
      const changes = collectLocalChanges({ cwd: root });
      const n = changes.kind === 'local-changes' ? changes.changedFiles.length : 0;
      console.log(pc.dim(`  project knowledge: fast refresh (${n} changed file(s))`));
    }

    // Repos to profile: the configured project's repos, else the current repo root.
    const repos: RepoInput[] = [];
    if (config && configuredProject) {
      const proj = config.projects.find((p) => p.name === configuredProject);
      for (const r of proj?.repositories ?? []) repos.push({ name: r.name, path: resolve(r.path) });
    }
    if (repos.length === 0) repos.push({ name: label, path: root });

    const snapshot = buildProjectKnowledge(repos, { project: label, gitSha });
    createJsonKnowledgeStore(root).write(snapshot, {
      generator: { tool: 'horus-cli' },
      git: { sha: gitSha, branch },
      repositories: repos.map((r) => ({ name: r.name, path: r.path, headSha: gitSha })),
      sourceIntelligence: config ? { tool: 'axon', version: config.axon.pinnedVersion } : undefined,
    });
    console.log(
      pc.dim(`  project knowledge: ${snapshot.repositories.length} repo profile(s) → .horus/index/`),
    );
  } catch (err) {
    // Knowledge building is best-effort and must never break `horus index`.
    console.log(pc.dim(`  project knowledge skipped: ${(err as Error).message}`));
  }
}

export async function runIndex(opts: IndexOptions): Promise<number> {
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

    // Build/refresh the local project-knowledge snapshot (HOR-293). Best-effort.
    buildKnowledgeIndex(root, config, label, configuredProject, opts);

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
      ensureProjectGitignore(root);
      console.log(`${pc.green('✓')} Indexed ${pc.bold(name)} — host ${hostUrl}`);
      console.log(pc.dim(`  ${configPath}`));
      console.log(
        pc.dim(
          `  investigate: horus investigate --name ${name} "<hint>"  (or from this repo: horus investigate "<hint>")`,
        ),
      );
    } else if (hostUrl !== configuredHost) {
      // The live host differs from what the config records — either no host was set
      // (HOR-150: reused host never persisted), or the configured host was dead and we
      // started a replacement on a different free port. In both cases persist the live
      // hostUrl so `status`/`doctor`/`investigate` target the running host, not a stale
      // or missing one.
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
        ensureProjectGitignore(root);
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
