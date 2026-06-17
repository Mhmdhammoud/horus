/**
 * Local-project discovery + registry (HOR-37).
 *
 * Horus can be driven git-style: a repo carries a `.horus/config.json`, discovered
 * by walking up from the working directory; a global registry at
 * `~/.horus/registry.json` lets `--name` resolve a project from anywhere.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const HORUS_DIR = '.horus';
export const LOCAL_CONFIG_FILE = 'config.json';

/** Absolute path to a repo's local config file. */
export function localConfigPath(root: string): string {
  return join(root, HORUS_DIR, LOCAL_CONFIG_FILE);
}

/** Walk up from `start` for a `.horus/config.json`; returns its absolute path or null. */
export function discoverLocalConfig(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = localConfigPath(dir);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Walk up from `start` for a `.git` directory → repo root; else null. */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Global registry (~/.horus/registry.json)
// ---------------------------------------------------------------------------

export interface RegistryEntry {
  root: string;
  configPath: string;
}
export interface Registry {
  projects: Record<string, RegistryEntry>;
}

export function registryPath(): string {
  return join(homedir(), HORUS_DIR, 'registry.json');
}

export function readRegistry(): Registry {
  const p = registryPath();
  if (!existsSync(p)) return { projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<Registry>;
    return { projects: parsed.projects ?? {} };
  } catch {
    return { projects: {} };
  }
}

export function writeRegistry(reg: Registry): void {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(reg, null, 2) + '\n');
}

export function registerProject(name: string, root: string, configPath: string): void {
  const reg = readRegistry();
  reg.projects[name] = { root, configPath };
  writeRegistry(reg);
}

export function lookupProject(name: string): RegistryEntry | null {
  return readRegistry().projects[name] ?? null;
}

// ---------------------------------------------------------------------------
// Local config file shape
// ---------------------------------------------------------------------------

export interface LocalConfigFile {
  version: number;
  /** A single ProjectConfig-shaped object (name, repositories[], environments[]). */
  project: unknown;
  /** Optional Postgres override; defaults to DATABASE_URL / the local default. */
  database?: { url: string };
  /** Optional AI narrative settings (provider + Anthropic key/model) — HOR-206. */
  ai?: unknown;
}

/** Write a `.horus/config.json` under `root` and return its absolute path. */
export function writeLocalConfig(root: string, file: LocalConfigFile): string {
  const dir = join(root, HORUS_DIR);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, LOCAL_CONFIG_FILE);
  writeFileSync(p, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  // chmod after write enforces 0600 on pre-existing files too — writeFileSync's
  // mode flag is ignored when the file already exists on most platforms.
  chmodSync(p, 0o600);
  return p;
}

/**
 * Ensure `.horus/config.json` is listed in `.horus/.gitignore`.
 * Called by `horus connect` when literal credential values (url/password) are
 * written into the config, so that secrets are not accidentally committed.
 */
export function ensureCredentialGitignore(root: string): void {
  const dir = join(root, HORUS_DIR);
  mkdirSync(dir, { recursive: true });
  const gitignorePath = join(dir, '.gitignore');
  const entry = 'config.json';
  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf8');
    if (existing.split('\n').some((l) => l.trim() === entry)) return;
    writeFileSync(gitignorePath, existing.trimEnd() + '\n' + entry + '\n');
  } else {
    writeFileSync(gitignorePath, entry + '\n');
  }
}

export function readLocalConfig(path: string): LocalConfigFile {
  return JSON.parse(readFileSync(path, 'utf8')) as LocalConfigFile;
}

/**
 * Ensure the project's root `.gitignore` ignores the `.horus/` directory, so the
 * local config and machine-specific runtime state (host.json, logs, source index)
 * are never committed. Called by `horus init` / `horus index` when onboarding a repo.
 *
 * Behavior:
 *   - No `.git` directory under `root` → no-op (not a git repo, nothing to ignore).
 *   - `.gitignore` missing → create it with a `.horus/` entry.
 *   - `.gitignore` present without a `.horus` entry → append one.
 *   - `.horus` already ignored (any common spelling) → no-op.
 */
export function ensureProjectGitignore(root: string): void {
  if (!existsSync(join(root, '.git'))) return;

  const gitignorePath = join(root, '.gitignore');
  const entry = '.horus/';

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, entry + '\n');
    return;
  }

  const existing = readFileSync(gitignorePath, 'utf8');
  const alreadyIgnored = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === '.horus' || l === '.horus/' || l === '/.horus' || l === '/.horus/');
  if (alreadyIgnored) return;

  writeFileSync(gitignorePath, existing.trimEnd() + '\n' + entry + '\n');
}

/**
 * Patch a single connector's config in an existing `.horus/config.json`.
 * If `envName` is omitted, targets the first environment in the project.
 * Merges `patch` into any existing connector config (so partial updates work).
 */
export function patchLocalConnector(
  configPath: string,
  connectorType: string,
  patch: Record<string, unknown>,
  envName?: string,
): void {
  const file = readLocalConfig(configPath);
  const project = file.project as Record<string, unknown>;
  const envs = project['environments'] as Array<Record<string, unknown>> | undefined;
  if (!envs || envs.length === 0) throw new Error('No environments found in config.');

  const env = envName
    ? envs.find((e) => e['name'] === envName)
    : envs[0];
  if (!env) throw new Error(`Environment "${envName ?? envs[0]?.['name']}" not found in config.`);

  if (!env['connectors'] || typeof env['connectors'] !== 'object') {
    env['connectors'] = {};
  }
  const connectors = env['connectors'] as Record<string, unknown>;
  connectors[connectorType] = { ...(connectors[connectorType] as Record<string, unknown> ?? {}), ...patch };

  const root = configPath.replace(`/${HORUS_DIR}/${LOCAL_CONFIG_FILE}`, '');
  writeLocalConfig(root, file);
}
