import { z } from 'zod';
import { createJiti } from 'jiti';
import { resolve } from 'node:path';

/**
 * Horus configuration schema. Loaded from `config/horus.config.ts` (or a path given
 * to `loadConfig`). Validated with zod so a malformed config fails at startup with a
 * clear message rather than deep in the pipeline.
 *
 * HOR-34: Config is now project/environment scoped. No connector may run without an
 * explicit project/env scope; the old global `providers` block is gone.
 */

// ---------------------------------------------------------------------------
// Connector-level schemas (per environment)
// ---------------------------------------------------------------------------

const connectorsSchema = z
  .object({
    axon: z
      .object({
        hostUrl: z.string().url(),
      })
      .optional(),
    elasticsearch: z
      .object({
        indexPattern: z.string(),
        serviceName: z.string().optional(),
        /** Name of the env var holding the ES base URL. Defaults to "ES_URL". */
        urlEnv: z.string().optional(),
        /** Name of the env var holding the ES username. Defaults to "ES_USERNAME". */
        usernameEnv: z.string().optional(),
        /** Name of the env var holding the ES password. Defaults to "ES_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    mongodb: z
      .object({
        database: z.string(),
        collections: z.array(z.string()).default([]),
        /** Name of the env var holding the MongoDB URL. Defaults to "MONGODB_URL". */
        urlEnv: z.string().optional(),
      })
      .optional(),
    grafana: z
      .object({
        dashboard: z.string().optional(),
        /** Name of the env var holding the Grafana base URL. Defaults to "GRAFANA_URL". */
        urlEnv: z.string().optional(),
        /** Name of the env var holding the Grafana username. Defaults to "GRAFANA_USER". */
        usernameEnv: z.string().optional(),
        /** Name of the env var holding the Grafana password. Defaults to "GRAFANA_PASSWORD". */
        passwordEnv: z.string().optional(),
      })
      .optional(),
    redis: z
      .object({
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
  path: z.string().min(1),
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
export type EnvironmentConfig = z.infer<typeof environmentSchema>;
export type ConnectorsConfig = z.infer<typeof connectorsSchema>;

// ---------------------------------------------------------------------------
// Resolved environment types (runtime, with secrets read from process.env)
// ---------------------------------------------------------------------------

export interface ResolvedConnectors {
  axon?: { hostUrl: string };
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
 * - project: use `opts.project` if given; else the single configured project; else throw.
 * - env: use `opts.env` if given; else the single env; else the one named "production"; else throw.
 */
export function resolveEnvironment(
  config: HorusConfig,
  opts?: { project?: string; env?: string },
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
    const names = config.projects.map((p) => p.name).join(', ');
    throw new Error(
      `Multiple projects configured; pass --project <name> (one of: ${names})`,
    );
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

  // --- resolve connectors ---
  const c = environment.connectors;
  const resolved: ResolvedConnectors = {};

  if (c.axon !== undefined) {
    resolved.axon = { hostUrl: c.axon.hostUrl };
  }

  if (c.elasticsearch !== undefined) {
    const es = c.elasticsearch;
    const url = process.env[es.urlEnv ?? 'ES_URL'];
    // Always include the block (with indexPattern) — callers null-guard the url.
    resolved.elasticsearch = {
      url: url ?? '',
      username: process.env[es.usernameEnv ?? 'ES_USERNAME'],
      password: process.env[es.passwordEnv ?? 'ES_PASSWORD'],
      indexPattern: es.indexPattern,
      serviceName: es.serviceName,
    };
  }

  if (c.mongodb !== undefined) {
    const m = c.mongodb;
    resolved.mongodb = {
      url: process.env[m.urlEnv ?? 'MONGODB_URL'],
      database: m.database,
      collections: m.collections,
    };
  }

  if (c.grafana !== undefined) {
    const g = c.grafana;
    resolved.grafana = {
      url: process.env[g.urlEnv ?? 'GRAFANA_URL'],
      username: process.env[g.usernameEnv ?? 'GRAFANA_USER'],
      password: process.env[g.passwordEnv ?? 'GRAFANA_PASSWORD'],
      dashboard: g.dashboard,
    };
  }

  if (c.redis !== undefined) {
    const r = c.redis;
    resolved.redis = {
      url: process.env[r.urlEnv ?? 'REDIS_URL'],
    };
  }

  return {
    project: project.name,
    env: environment.name,
    readOnly: environment.readOnly,
    path: project.path,
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

/**
 * Load and validate a Horus config module. `configPath` defaults to
 * `config/horus.config.ts` resolved from the current working directory.
 */
export async function loadConfig(configPath?: string): Promise<HorusConfig> {
  const target = resolve(configPath ?? 'config/horus.config.ts');
  // Load via jiti so a TypeScript config (and its TS workspace imports) works under
  // any runtime — `tsx` in dev or plain `node` from the bundled binary.
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
  const parsed = horusConfigSchema.safeParse(mod.default);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Horus config:\n${details}`);
  }
  return parsed.data;
}
