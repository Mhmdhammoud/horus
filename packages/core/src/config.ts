import { z } from 'zod';
import { createJiti } from 'jiti';
import { resolve } from 'node:path';

/**
 * Horus configuration schema. Loaded from `config/horus.config.ts` (or a path given
 * to `loadConfig`). Validated with zod so a malformed config fails at startup with a
 * clear message rather than deep in the pipeline.
 */

const repoSchema = z.object({
  /** Stable identifier used in the repo registry and on every queue edge. */
  name: z.string().min(1),
  /** Absolute or config-relative path to the repository root. */
  path: z.string().min(1),
  /**
   * Per-repo Axon host URL. When set, overrides `axon.hostUrl` for this repo so
   * each repository can point at its own running `axon host` instance (HOR-28).
   */
  axonHostUrl: z.string().url().optional(),
});

const axonSchema = z.object({
  /**
   * Base URL of a running `axon host`. Horus speaks HTTP/MCP only — never CLI
   * shell-outs for queries (the 1.0.1 CLI query surface is broken). See
   * architecture.md §1.5.
   */
  hostUrl: z.string().url().default('http://127.0.0.1:8420'),
  /** Fail fast if the running Axon is not this version. */
  pinnedVersion: z.string().default('1.0.1'),
});

const databaseSchema = z.object({
  /** Postgres connection string. Plain Postgres — no pgvector in v0. */
  url: z.string().min(1),
});

const modelsSchema = z.object({
  reasoning: z.string().default('claude-opus-4-8'),
  extraction: z.string().default('claude-haiku-4-5'),
});

const providerCredsSchema = z
  .object({
    elasticsearch: z
      .object({
        url: z.string().url(),
        username: z.string(),
        password: z.string(),
        indexPattern: z.string(),
      })
      .partial()
      .optional(),
    prometheus: z.object({ url: z.string().url() }).partial().optional(),
    redis: z.object({ url: z.string() }).partial().optional(),
  })
  .default({});

export const horusConfigSchema = z.object({
  repos: z.array(repoSchema).default([]),
  axon: axonSchema.default({}),
  database: databaseSchema,
  models: modelsSchema.default({}),
  providers: providerCredsSchema,
});

export type HorusConfig = z.infer<typeof horusConfigSchema>;
export type RepoConfig = z.infer<typeof repoSchema>;

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
