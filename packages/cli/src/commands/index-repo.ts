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
  PINNED_SOURCE_VERSION,
  type HorusConfig,
  type LocalConfigFile,
} from '@horus/core';
import {
  buildProjectKnowledge,
  createJsonKnowledgeStore,
  importKnowledgeBaseFile,
  type RepoInput,
  type SourceGraphExtract,
  type SourceSymbolInput,
  type SourceProcessInput,
} from '@horus/knowledge';
import {
  SourceHttpClient,
  sourceAvailable,
  assertSourceVersionPinned,
  isAnalyzed,
  analyzeRepo,
  isHostHealthy,
  readSourceHostUrl,
  findFreePort,
  startHost,
  waitForOwnHost,
  killSpawnedHost,
  reconcileSpawnedHost,
} from '@horus/connectors';
import { openDb } from '@horus/db';
import { stitch } from '@horus/stitcher';
import { parseHostPort } from '../lib/ensure-host.js';

async function stitchQueueMap(hostUrl: string, dbUrl: string, label: string): Promise<void> {
  const source = new SourceHttpClient({ baseUrl: hostUrl });
  const { db, sql } = await openDb(dbUrl);
  try {
    const summary = await stitch(source, db, { project: label });
    console.log(
      pc.dim(`[${label}]  `) +
        `Stitched ${summary.edges} queue edge(s) across ${summary.queues} queue(s) — ` +
        `${summary.producers} producer(s), ${summary.workers} worker(s).`,
    );
  } finally {
    await sql.end();
  }
}

/**
 * Whether the source-intelligence host at `hostUrl` is serving `root` (and not another repo
 * that happens to occupy the same port). Best-effort: if the host can't report its repo
 * (older backend / transient error) we do NOT block reuse, preserving prior behaviour.
 */
async function hostServesRepo(hostUrl: string, root: string): Promise<boolean> {
  try {
    const info = await new SourceHttpClient({ baseUrl: hostUrl }).hostInfo();
    return resolve(info.repoPath) === resolve(root);
  } catch {
    return true;
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
        const hostUrl = r.source?.hostUrl;
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
 * Cap per-category Cypher pulls so a huge monorepo can't bloat the knowledge base
 * or stall `horus index`. Matches the knowledge bridge's own defensive cap.
 */
const SOURCE_GRAPH_PULL_LIMIT = 5000;

/**
 * Read the analysed source graph back from the running host over read-only Cypher
 * and shape it into a `SourceGraphExtract` (HOR-408). This is the bridge the
 * knowledge pass was missing: the rich analyse output (functions, classes,
 * interfaces, type aliases, enums, semantic communities, execution-flow
 * processes) is pulled here and mapped into the KB categories that were empty.
 *
 * Best-effort and fully guarded — any query the backend rejects (older graph
 * shape, transient error) degrades to "no rows" for that slice so the rest of
 * the extract still lands. Returns `null` only if nothing at all could be read.
 */
async function extractSourceGraph(
  hostUrl: string,
  repo: string,
): Promise<SourceGraphExtract | null> {
  const client = new SourceHttpClient({ baseUrl: hostUrl });
  const N = SOURCE_GRAPH_PULL_LIMIT;

  const rows = async (query: string): Promise<unknown[][]> => {
    try {
      return (await client.cypher(query)).rows;
    } catch {
      return [];
    }
  };

  // Symbols: types (Class/Interface/TypeAlias), callables (Function/Method), enums.
  const symbolRows = await rows(
    'MATCH (n) WHERE label(n) IN ["Class","Interface","TypeAlias","Function","Method","Enum"] ' +
      'RETURN label(n), n.name, n.file_path, n.start_line, n.end_line, n.class_name, ' +
      `n.is_entry_point, n.is_exported, n.signature LIMIT ${N * 2}`,
  );
  const symbols: SourceSymbolInput[] = symbolRows.map((r) => ({
    label: String(r[0] ?? ''),
    name: String(r[1] ?? ''),
    filePath: r[2] != null ? String(r[2]) : undefined,
    startLine: r[3] != null ? Number(r[3]) : undefined,
    endLine: r[4] != null ? Number(r[4]) : undefined,
    className: r[5] != null ? String(r[5]) : undefined,
    isEntryPoint: Boolean(r[6]),
    isExported: Boolean(r[7]),
    signature: r[8] != null ? String(r[8]) : undefined,
  }));

  // Communities (semantic clusters → domain concepts).
  const communityRows = await rows(
    `MATCH (n:Community) RETURN n.id, n.name LIMIT ${N}`,
  );
  const communities = communityRows.map((r) => ({
    id: r[0] != null ? String(r[0]) : undefined,
    name: String(r[1] ?? ''),
  }));

  // Processes (execution flows → data flows) + their ordered steps in one pull.
  const processRows = await rows(`MATCH (n:Process) RETURN n.id, n.name LIMIT ${N}`);
  const stepRows = await rows(
    'MATCH (s)-[r:CodeRelation]->(p:Process) WHERE r.rel_type = "step_in_process" ' +
      `RETURN p.id, s.name, s.file_path, r.step_number ORDER BY p.id, r.step_number LIMIT ${N * 4}`,
  );
  const stepsByProcess = new Map<string, { component: string; detail?: string }[]>();
  for (const r of stepRows) {
    const pid = String(r[0] ?? '');
    if (!pid) continue;
    const component = String(r[1] ?? '');
    if (!component) continue;
    const file = r[2] != null ? String(r[2]) : undefined;
    const list = stepsByProcess.get(pid) ?? [];
    list.push({ component, ...(file ? { detail: file } : {}) });
    stepsByProcess.set(pid, list);
  }
  const processes: SourceProcessInput[] = processRows.map((r) => {
    const id = r[0] != null ? String(r[0]) : undefined;
    return {
      id,
      name: String(r[1] ?? ''),
      steps: id ? (stepsByProcess.get(id) ?? []) : [],
    };
  });

  if (
    symbols.length === 0 &&
    communities.length === 0 &&
    processes.length === 0
  ) {
    return null;
  }
  return { repo, symbols, communities, processes };
}

/**
 * Additive project-knowledge pass (HOR-293). Best-effort: never fails `horus index`.
 * `--changed --fast` is the pre-push-safe path (cheap landscape refresh + changed-file
 * awareness); `--full` rebuilds the landscape. Deeper per-file extraction (contracts,
 * types, data flows) layers on top later using the changed-file set.
 */
async function buildKnowledgeIndex(
  root: string,
  config: HorusConfig | null,
  label: string,
  configuredProject: string | null,
  opts: IndexOptions,
  hostUrl?: string,
): Promise<void> {
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

    // Bridge the analysed source graph into the KB (HOR-408). The host serves THIS
    // repo, so the graph is attributed to the repo whose root we indexed (the lone
    // repo when unconfigured, else the configured repo matching `root`). Best-effort:
    // a failed pull just leaves the symbol-derived categories empty (manifest-only).
    let sourceGraph: SourceGraphExtract | undefined;
    if (hostUrl) {
      const graphRepo =
        repos.find((r) => resolve(r.path) === resolve(root))?.name ?? label;
      try {
        const extract = await extractSourceGraph(hostUrl, graphRepo);
        if (extract) sourceGraph = extract;
      } catch {
        /* best-effort: fall back to the manifest-only landscape */
      }
    }

    const snapshot = buildProjectKnowledge(repos, { project: label, gitSha, sourceGraph });
    createJsonKnowledgeStore(root).write(snapshot, {
      generator: { tool: 'horus-cli' },
      git: { sha: gitSha, branch },
      repositories: repos.map((r) => ({ name: r.name, path: r.path, headSha: gitSha })),
      sourceIntelligence: config ? { tool: 'source', version: PINNED_SOURCE_VERSION } : undefined,
    });
    const counts = [
      snapshot.repositories.length ? `${snapshot.repositories.length} repo(s)` : null,
      snapshot.operations.length ? `${snapshot.operations.length} operation(s)` : null,
      snapshot.types.length ? `${snapshot.types.length} type(s)` : null,
      snapshot.domainConcepts.length ? `${snapshot.domainConcepts.length} concept(s)` : null,
      snapshot.dataFlows.length ? `${snapshot.dataFlows.length} flow(s)` : null,
    ].filter(Boolean);
    console.log(
      pc.dim(`  project knowledge: ${counts.join(', ')} → .horus/index/`),
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
          configuredHost = renv.repositories[0]?.sourceHostUrl;
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
      // Reuse a host only if it is healthy AND actually serving THIS repo — never another
      // repo's host that happens to occupy the same port (the collision that leaked one
      // repo's queue map into another's investigation).
      if (candidate && (await isHostHealthy(candidate)) && (await hostServesRepo(candidate, root))) {
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
        console.error(pc.red('horus-source not found on PATH. Install it: curl -fsSL https://horus.sh/install.sh | bash'));
        return 1;
      }
      // Refuse to analyze or host with a drifted backend — a version mismatch corrupts
      // the Kùzu graph identically on every rebuild, so a plain reindex can never recover.
      try {
        await assertSourceVersionPinned();
      } catch (err) {
        console.error(pc.red(`  ${(err as Error).message}`));
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
      // Prefer this repo's OWN prior port (from its config or last host.json) so a re-index
      // keeps a STABLE port and never grabs the default 8420 out from under another repo —
      // the port-collision that let one repo reuse another's host and leak its queue map.
      //
      // findFreePort is check-then-release, so two repos indexing CONCURRENTLY can pick the
      // same free port (TOCTOU) and one backend then fails to bind. Retry on a fresh port
      // when the host doesn't come up, which makes parallel first-index race-safe (HOR-357).
      const priorPort =
        parseHostPort(configuredHost ?? '') ?? parseHostPort(readSourceHostUrl(root) ?? '');
      // Reuse already failed above, so any host still recorded for this repo is stale/unhealthy
      // (e.g. a previously hard-killed host that left the kùzu lock held). Reap it BEFORE spawning
      // so the new host can acquire the lock — otherwise it loops to "did not become healthy"
      // and the repo stays wedged until a manual `rm -rf .horus/source` (HOR-372).
      await killSpawnedHost(root);
      const MAX_PORT_ATTEMPTS = 4;
      let started = false;
      for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS && !started; attempt += 1) {
        let port: number;
        if (attempt === 0 && priorPort !== null) {
          try {
            port = await findFreePort(priorPort, priorPort); // exactly the home port, if free
          } catch {
            port = await findFreePort(); // home port busy (another repo) — take any free one
          }
        } else {
          port = await findFreePort();
        }
        hostUrl = `http://127.0.0.1:${port}`;
        console.log(
          pc.dim(
            attempt === 0
              ? `  starting source-intelligence host on port ${port}…`
              : `  port contended — retrying on ${port}…`,
          ),
        );
        startHost(root, port);
        // Defense-in-depth (HOR-409): do NOT trust a plain health check on the REQUESTED
        // port. Under concurrent contention the spawned host can fall back to a different
        // bound port, leaving the requested port serving a FOREIGN repo whose /api/health
        // answers 200 — grounding the index on it would investigate the wrong codebase.
        // waitForOwnHost resolves to the port the backend ACTUALLY bound and only returns a
        // host that VERIFIES it serves THIS repo.
        const ownUrl = await waitForOwnHost(root, hostUrl);
        if (ownUrl) {
          hostUrl = ownUrl; // the actual serving URL (requested port OR a safe fallback)
          // Point the ownership record at the backend's real server pid + actual bound port
          // (host.json), so a scoped `horus stop` can stop the host it really spawned even
          // when it fell back to a different port (no "port does not match" refusal).
          reconcileSpawnedHost(root, parseHostPort(ownUrl) ?? port);
          started = true;
        } else {
          // Didn't come up (or only a foreign host answered). KILL the spawn before retrying —
          // a slow-loading host that missed the health window would otherwise be orphaned still
          // holding the kùzu lock, and the next attempt (same kùzu) could never acquire it
          // (HOR-372). Killing releases the lock.
          await killSpawnedHost(root);
        }
      }
      if (!started) {
        console.error(
          pc.red(`  Source-intelligence host did not become healthy — see ${root}/.horus/source-host.log`),
        );
        return 1;
      }
    }

    // hostUrl is guaranteed set here (a host was reused or freshly started) — narrow for TS.
    if (!hostUrl) return 1;

    // Final contamination guard (HOR-409 / HOR-421): never read a host's graph until we have
    // confirmed /api/host reports it serves THIS repo. Both resolution paths already verify
    // (reuse via hostServesRepo, spawn via waitForOwnHost), but this is the last line of
    // defense before grounding — a wrong-port config must never feed another repo's data into
    // this repo's queue map or knowledge index. hostServesRepo only returns false for a
    // KNOWN-foreign host, so an older backend that can't report identity still proceeds.
    if (!(await hostServesRepo(hostUrl, root))) {
      console.error(
        pc.red(
          `  Source-intelligence host at ${hostUrl} is serving a DIFFERENT repository — ` +
            `refusing to index foreign code. Retry, or stop the stale host: horus stop`,
        ),
      );
      return 1;
    }

    // Build the queue map.
    await stitchQueueMap(hostUrl, dbUrl, label);

    // Build/refresh the local project-knowledge snapshot (HOR-293). Best-effort.
    // Passes the live host so the analysed source graph is bridged into the KB (HOR-408).
    await buildKnowledgeIndex(root, config, label, configuredProject, opts, hostUrl);

    // A repo is "set up" once it has a discoverable local config. Compute this from the repo
    // itself, NOT from `spawned`: a repo whose host was REUSED (not freshly spawned) used to
    // fall through without ever writing a config, so `investigate` then failed to load one
    // (the recurring "Cannot find module config/horus.config.ts").
    const hasLocalConfig = discoverLocalConfig(root) !== null;
    if (!isConfigured && !hasLocalConfig) {
      // No config anywhere for this repo — write a full local config and register it, whether
      // we spawned a host or reused one.
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
