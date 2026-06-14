import { z } from 'zod';
import { createJiti } from 'jiti';
import { resolve } from 'node:path';
import {
  discoverLocalConfig,
  findRepoRoot,
  lookupProject,
  readLocalConfig,
} from './discovery.js';

const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

/**
 * Horus configuration schema. Loaded from `config/horus.config.ts` (or a path given
 * to `loadConfig`). Validated with zod so a malformed config fails at startup with a
 * clear message rather than deep in the pipeline.
 *
 * HOR-34: Config is now project/environment scoped. No connector may run without an
 * explicit project/env scope; the old global `providers` block is gone.
 */

// ---------------------------------------------------------------------------
// Repository schema (CODE — belongs to the PROJECT, served by Axon)
// ---------------------------------------------------------------------------

const repositorySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  /**
   * Axon is the default source-intelligence backend. Each repository points at
   * the `axon host` indexing it. When absent/unreachable, source context, impact,
   * change analysis, and queue stitching degrade — runtime evidence still works.
   */
  axon: z.object({ hostUrl: z.string().url() }).optional(),
});

// ---------------------------------------------------------------------------
// Connector-level schemas (RUNTIME — belong to the ENVIRONMENT)
// ---------------------------------------------------------------------------

const connectorsSchema = z
  .object({
    elasticsearch: z
      .object({
        indexPattern: z.string(),
        serviceName: z.string().optional(),
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the ES base URL. Defaults to "ES_URL". */
        urlEnv: z.string().optional(),
        /** Direct username value (takes priority over usernameEnv). */
        username: z.string().optional(),
        /** Name of the env var holding the ES username. Defaults to "ES_USERNAME". */
        usernameEnv: z.string().optional(),
        /** Direct password value (takes priority over passwordEnv). */
        password: z.string().optional(),
        /** Name of the env var holding the ES password. Defaults to "ES_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    mongodb: z
      .object({
        database: z.string(),
        collections: z.array(z.string()).default([]),
        /** Direct connection string (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the MongoDB URL. Defaults to "MONGODB_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    grafana: z
      .object({
        dashboard: z.string().optional(),
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the Grafana base URL. Defaults to "GRAFANA_URL". */
        urlEnv: z.string().optional(),
        /** Direct username value (takes priority over usernameEnv). */
        username: z.string().optional(),
        /** Name of the env var holding the Grafana username. Defaults to "GRAFANA_USER". */
        usernameEnv: z.string().optional(),
        /** Direct password value (takes priority over passwordEnv). */
        password: z.string().optional(),
        /** Name of the env var holding the Grafana password. Defaults to "GRAFANA_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    redis: z
      .object({
        /** Direct URL value (takes priority over urlEnv). */
        url: z.string().optional(),
        /** Name of the env var holding the Redis URL. Defaults to "REDIS_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
  })
  .default({});

const environmentSchema = z.object({
  name: z.string().min(1),
  readOnly: z.boolean().default(true),
  connectors: connectorsSchema,
});

const projectSchema = z.object({
  name: z.string().min(1),
  /** Code repositories (with their Axon hosts) — code belongs to the project. */
  repositories: z.array(repositorySchema).min(1),
  /** Runtime environments — runtime systems belong to the environment. */
  environments: z.array(environmentSchema).min(1),
});

const databaseSchema = z.object({
  /** Postgres connection string. Plain Postgres — no pgvector in v0. */
  url: z.string().min(1),
});

const modelsSchema = z.object({
  reasoning: z.string().default('claude-opus-4-8'),
  extraction: z.string().default('claude-haiku-4-5'),
});

export const horusConfigSchema = z.object({
  projects: z.array(projectSchema).default([]),
  axon: z
    .object({
      /** Fail fast if the running Axon is not this version. */
      pinnedVersion: z.string().default('1.0.1'),
    })
    .default({}),
  database: databaseSchema,
  models: modelsSchema.default({}),
});

export type HorusConfig = z.infer<typeof horusConfigSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type RepositoryConfig = z.infer<typeof repositorySchema>;
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type ConnectorsConfig = z.infer<typeof connectorsSchema>;

// ---------------------------------------------------------------------------
// Resolved environment types (runtime, with secrets read from process.env)
// ---------------------------------------------------------------------------

export interface ResolvedRepository {
  name: string;
  path: string;
  axonHostUrl?: string;
}

export interface ResolvedConnectors {
  elasticsearch?: {
    url: string;
    username?: string;
    password?: string;
    indexPattern: string;
    serviceName?: string;
  };
  mongodb?: { url?: string; database: string; collections: string[] };
  grafana?: { url?: string; username?: string; password?: string; dashboard?: string };
  redis?: { url?: string };
}

export interface ResolvedEnvironment {
  project: string;
  env: string;
  readOnly: boolean;
  /** Code repositories for the project (with their Axon hosts). */
  repositories: ResolvedRepository[];
  /** Primary repository path (first repo) — convenience for git-based commands. */
  path: string;
  connectors: ResolvedConnectors;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Flatten all configured project/env pairs (for help text / matrix display). */
export function listEnvironments(config: HorusConfig): { project: string; env: string }[] {
  const out: { project: string; env: string }[] = [];
  for (const p of config.projects) {
    for (const e of p.environments) {
      out.push({ project: p.name, env: e.name });
    }
  }
  return out;
}

/**
 * Resolve a concrete environment from the config, reading connector secrets from
 * `process.env`. Throws a descriptive Error if resolution is ambiguous.
 *
 * Selection rules:
 * - project: use `opts.project` if given; else the single configured project; else
 *   infer from the current repo (a project whose repository path contains `opts.cwd`);
 *   else throw.
 * - env: use `opts.env` if given; else the single env; else the one named "production"; else throw.
 */
export function resolveEnvironment(
  config: HorusConfig,
  opts?: { project?: string; env?: string; cwd?: string },
): ResolvedEnvironment {
  // --- pick project ---
  let project: ProjectConfig;
  if (opts?.project !== undefined) {
    const found = config.projects.find((p) => p.name === opts.project);
    if (found === undefined) {
      const names = config.projects.map((p) => p.name).join(', ');
      throw new Error(
        `Unknown project: ${opts.project} (configured: ${names || 'none'})`,
      );
    }
    project = found;
  } else if (config.projects.length === 1) {
    const p = config.projects[0];
    if (p === undefined) throw new Error('No projects configured.');
    project = p;
  } else {
    // No --project and multiple projects: infer from the current repo by matching
    // its root against a project's repository paths (so `cd repo && horus …` works).
    const cwd = opts?.cwd ?? process.cwd();
    const root = findRepoRoot(cwd) ?? resolve(cwd);
    const matches = config.projects.filter((p) =>
      p.repositories.some((r) => resolve(r.path) === root),
    );
    const inferred = matches[0];
    if (matches.length === 1 && inferred !== undefined) {
      project = inferred;
    } else {
      const names = config.projects.map((p) => p.name).join(', ');
      throw new Error(
        `Multiple projects configured; pass --project <name> (one of: ${names}) ` +
          `— or run from inside a project's repository.`,
      );
    }
  }

  // --- pick environment ---
  let environment: EnvironmentConfig;
  if (opts?.env !== undefined) {
    const found = project.environments.find((e) => e.name === opts.env);
    if (found === undefined) {
      const names = project.environments.map((e) => e.name).join(', ');
      throw new Error(
        `Unknown environment: ${opts.env} in project ${project.name} (one of: ${names})`,
      );
    }
    environment = found;
  } else if (project.environments.length === 1) {
    const e = project.environments[0];
    if (e === undefined) throw new Error(`Project ${project.name} has no environments.`);
    environment = e;
  } else {
    const prod = project.environments.find((e) => e.name === 'production');
    if (prod !== undefined) {
      environment = prod;
    } else {
      const names = project.environments.map((e) => e.name).join(', ');
      throw new Error(
        `Project ${project.name} has multiple environments; pass --env <name> (one of: ${names})`,
      );
    }
  }

  // --- resolve repositories (code/Axon belong to the project) ---
  const repositories: ResolvedRepository[] = project.repositories.map((r) => ({
    name: r.name,
    path: r.path,
    ...(r.axon ? { axonHostUrl: r.axon.hostUrl } : {}),
  }));
  const primary = repositories[0];

  // --- resolve connectors (runtime belongs to the environment) ---
  const c = environment.connectors;
  const resolved: ResolvedConnectors = {};

  if (c.elasticsearch !== undefined) {
    const es = c.elasticsearch;
    // Direct value takes priority over env var name.
    const url = es.url ?? process.env[es.urlEnv ?? 'ES_URL'] ?? '';
    resolved.elasticsearch = {
      url,
      username: es.username ?? process.env[es.usernameEnv ?? 'ES_USERNAME'],
      password: es.password ?? process.env[es.passwordEnv ?? 'ES_PASSWORD'],
      indexPattern: es.indexPattern,
      serviceName: es.serviceName,
    };
  }

  if (c.mongodb !== undefined) {
    const m = c.mongodb;
    resolved.mongodb = {
      url: m.url ?? process.env[m.urlEnv ?? 'MONGODB_URL'],
      database: m.database,
      collections: m.collections,
    };
  }

  if (c.grafana !== undefined) {
    const g = c.grafana;
    resolved.grafana = {
      url: g.url ?? process.env[g.urlEnv ?? 'GRAFANA_URL'],
      username: g.username ?? process.env[g.usernameEnv ?? 'GRAFANA_USER'],
      password: g.password ?? process.env[g.passwordEnv ?? 'GRAFANA_PASSWORD'],
      dashboard: g.dashboard,
    };
  }

  if (c.redis !== undefined) {
    const r = c.redis;
    resolved.redis = {
      url: r.url ?? process.env[r.urlEnv ?? 'REDIS_URL'],
    };
  }

  return {
    project: project.name,
    env: environment.name,
    readOnly: environment.readOnly,
    repositories,
    path: primary?.path ?? '',
    connectors: resolved,
  };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** Helper so config files get full type-checking and inference. */
export function defineConfig(config: HorusConfig): HorusConfig {
  return config;
}

/** Validate a raw config object, throwing a readable error on failure. */
function parseConfig(raw: unknown, source: string): HorusConfig {
  const parsed = horusConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Horus config (${source}):\n${details}`);
  }
  return parsed.data;
}

/** Load a config file by absolute path — JSON (`.horus/config.json`) or a TS module. */
async function loadConfigFile(target: string): Promise<HorusConfig> {
  if (target.endsWith('.json')) {
    // A local `.horus/config.json` wraps a single project.
    const file = readLocalConfig(target);
    const raw = {
      projects: file.project ? [file.project] : [],
      database: file.database ?? {
        url: process.env['DATABASE_URL'] ?? DEFAULT_DB_URL,
      },
    };
    return parseConfig(raw, target);
  }

  // A TS config module, loaded via jiti so it works under tsx or the bundled binary.
  const jiti = createJiti(import.meta.url);
  let mod: { default?: unknown };
  try {
    mod = (await jiti.import(target)) as { default?: unknown };
  } catch (err) {
    throw new Error(
      `Could not load Horus config at ${target}: ${(err as Error).message}`,
    );
  }
  if (!mod.default) {
    throw new Error(`Horus config at ${target} must have a default export.`);
  }
  return parseConfig(mod.default, target);
}

/**
 * Load and validate the active Horus config. Resolution order:
 *   1. an explicit `configPath` (e.g. `--config`)
 *   2. `opts.name` → the global project registry (`~/.horus/registry.json`)
 *   3. a discovered `.horus/config.json` walking up from `opts.cwd` (git-style)
 *   4. the `HORUS_CONFIG` environment variable
 *   5. `config/horus.config.ts` relative to the current working directory
 */
export async function loadConfig(
  configPath?: string,
  opts?: { name?: string; cwd?: string },
): Promise<HorusConfig> {
  const cwd = opts?.cwd ?? process.cwd();

  let target: string;
  if (configPath) {
    target = resolve(configPath);
  } else if (opts?.name) {
    const entry = lookupProject(opts.name);
    if (entry === null) {
      throw new Error(
        `Unknown project "${opts.name}". Run \`horus index --name ${opts.name}\` in its repo, ` +
          `or list registered projects with \`horus projects\`.`,
      );
    }
    target = entry.configPath;
  } else {
    const discovered = discoverLocalConfig(cwd);
    target = discovered ?? resolve(process.env['HORUS_CONFIG'] ?? 'config/horus.config.ts');
  }

  return loadConfigFile(target);
}
