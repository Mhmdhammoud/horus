/**
 * `horus notify` — configure the outbound notify sink for `horus watch` (HOR-454).
 *
 * Subcommands:
 *   set     write/patch the notify block on an environment (url, threshold, cloud); the webhook
 *           signing secret is stored ENCRYPTED in .horus/secrets.local.json (HOR-452), never
 *           plaintext in config.json.
 *   show    print the current notify config for an environment (secret masked).
 *   test    send a sample signed dispatch to the configured webhook to verify it end-to-end.
 *   remove  delete the notify block from an environment.
 *
 * Mirrors `horus connect`: resolves the repo root + local config.json, patches the chosen
 * environment in place, and routes the secret through the same encrypted-secret machinery.
 */
import pc from 'picocolors';
import {
  findRepoRoot,
  discoverLocalConfig,
  localConfigPath,
  readLocalConfig,
  writeLocalConfig,
  writeConnectorSecret,
  ensureMasterKey,
  ensureProjectGitignore,
  type LocalConfigFile,
} from '@horus/core';
import { dispatchNotify } from '../lib/notify-sink.js';

export interface NotifyOptions {
  config?: string;
  env?: string;
  url?: string;
  secret?: string;
  minConfidence?: string;
  /** Tri-state from commander's --cloud / --no-cloud: true | false | undefined (unchanged). */
  cloud?: boolean;
}

interface EnvBlock {
  name?: string;
  notify?: {
    minConfidence?: number;
    webhook?: { url?: string; secret?: string };
    cloud?: boolean;
  };
  [k: string]: unknown;
}

/** Locate the repo root + config path, or print a hint and return null. */
function locate(opts: NotifyOptions): { root: string; configPath: string } | null {
  const cwd = process.cwd();
  const configPath = opts.config ?? discoverLocalConfig(cwd) ?? null;
  const root = findRepoRoot(cwd);
  if (root === null) {
    console.error(pc.red('Not inside a git repository — run this from your project.'));
    return null;
  }
  const resolved = configPath ?? localConfigPath(root);
  return { root, configPath: resolved };
}

/** Pick the target environment block by name (or the first), or null with a printed error. */
function pickEnv(file: LocalConfigFile, requested?: string): EnvBlock | null {
  const project = file.project as { environments?: EnvBlock[] } | undefined;
  const envs = project?.environments ?? [];
  if (envs.length === 0) {
    console.error(pc.red('No environments in config — run `horus connect` or `horus init` first.'));
    return null;
  }
  if (requested) {
    const found = envs.find((e) => e.name === requested);
    if (!found) {
      console.error(pc.red(`Environment "${requested}" not found in config.`));
      return null;
    }
    return found;
  }
  return envs[0] ?? null;
}

function readConfigOrError(configPath: string): LocalConfigFile | null {
  try {
    return readLocalConfig(configPath);
  } catch {
    console.error(pc.red(`No config found at ${configPath} — run \`horus connect\` or \`horus init\` first.`));
    return null;
  }
}

async function runSet(opts: NotifyOptions): Promise<number> {
  if (!opts.url) {
    console.error(pc.red('A webhook URL is required: horus notify set --url <https://…> [--secret <s>] [--min-confidence 0.6] [--cloud]'));
    return 1;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(opts.url);
  } catch {
    console.error(pc.red(`Invalid --url "${opts.url}".`));
    return 1;
  }
  let minConfidence: number | undefined;
  if (opts.minConfidence !== undefined) {
    const n = Number(opts.minConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      console.error(pc.red(`--min-confidence must be between 0 and 1 (got "${opts.minConfidence}").`));
      return 1;
    }
    minConfidence = n;
  }

  const loc = locate(opts);
  if (!loc) return 1;
  const file = readConfigOrError(loc.configPath);
  if (!file) return 1;
  const env = pickEnv(file, opts.env);
  if (!env) return 1;
  const envName = env.name ?? 'production';

  // Non-secret fields → config.json. The signing secret → encrypted secrets store (never plaintext).
  const notify = (env.notify ??= {});
  notify.webhook = { url: opts.url };
  if (minConfidence !== undefined) notify.minConfidence = minConfidence;
  if (opts.cloud !== undefined) notify.cloud = opts.cloud;

  writeLocalConfig(loc.root, file);
  ensureProjectGitignore(loc.root);

  let secretNote = '';
  if (opts.secret) {
    try {
      const key = ensureMasterKey();
      writeConnectorSecret(loc.root, envName, 'notify', 'webhookSecret', opts.secret, key.key);
      secretNote = pc.dim(' · signing secret stored encrypted (.horus/secrets.local.json)');
    } catch (err) {
      console.error(pc.yellow(`Notify URL saved, but the signing secret could not be encrypted: ${(err as Error).message}`));
    }
  }

  console.log(
    pc.green(`✓ Notify sink configured for "${envName}"`) +
      `\n  ${pc.dim('webhook:')} ${opts.url}` +
      `\n  ${pc.dim('threshold:')} ${notify.minConfidence ?? 0.6}` +
      `\n  ${pc.dim('cloud:')} ${notify.cloud === true}${secretNote}`,
  );
  console.log(pc.dim('  Run `horus notify test` to send a sample, or `horus watch` to start monitoring.'));
  return 0;
}

function runShow(opts: NotifyOptions): number {
  const loc = locate(opts);
  if (!loc) return 1;
  const file = readConfigOrError(loc.configPath);
  if (!file) return 1;
  const env = pickEnv(file, opts.env);
  if (!env) return 1;
  if (!env.notify || !env.notify.webhook?.url) {
    console.log(pc.dim(`No notify sink configured for "${env.name}". Set one: horus notify set --url <https://…>`));
    return 0;
  }
  const n = env.notify;
  console.log(
    pc.bold(`Notify sink for "${env.name}"`) +
      `\n  webhook:    ${n.webhook?.url}` +
      `\n  threshold:  ${n.minConfidence ?? 0.6}` +
      `\n  cloud:      ${n.cloud === true}`,
  );
  return 0;
}

async function runTest(opts: NotifyOptions): Promise<number> {
  // Build a resolved view so the encrypted secret is hydrated (loadConfig path).
  const { loadConfig, resolveEnvironment } = await import('@horus/core');
  let notify;
  try {
    const config = await loadConfig(opts.config);
    const renv = resolveEnvironment(config, { env: opts.env });
    notify = renv.notify;
  } catch (err) {
    console.error(pc.red(`Could not load config: ${(err as Error).message}`));
    return 1;
  }
  if (!notify || !notify.webhook) {
    console.error(pc.red('No webhook configured — run `horus notify set --url <https://…>` first.'));
    return 1;
  }
  const results = await dispatchNotify(
    {
      id: 'test-' + Date.now().toString(36),
      confidence: Math.max(notify.minConfidence, 0.99),
      hint: 'horus notify test',
      cause: 'This is a test dispatch from `horus notify test` — your sink is wired up correctly.',
    },
    { ...notify, minConfidence: 0 },
  );
  if (results.length === 0) {
    console.error(pc.yellow('Nothing dispatched (no target enabled).'));
    return 1;
  }
  let ok = true;
  for (const r of results) {
    if (r.ok) console.log(pc.green(`✓ ${r.target} — ${r.detail}`));
    else {
      ok = false;
      console.error(pc.red(`✗ ${r.target} — ${r.detail}`));
    }
  }
  return ok ? 0 : 1;
}

function runRemove(opts: NotifyOptions): number {
  const loc = locate(opts);
  if (!loc) return 1;
  const file = readConfigOrError(loc.configPath);
  if (!file) return 1;
  const env = pickEnv(file, opts.env);
  if (!env) return 1;
  if (!env.notify) {
    console.log(pc.dim(`No notify sink configured for "${env.name}".`));
    return 0;
  }
  delete env.notify;
  writeLocalConfig(loc.root, file);
  console.log(pc.green(`✓ Removed notify sink from "${env.name}".`));
  console.log(pc.dim('  (Any stored signing secret remains in .horus/secrets.local.json — remove it with `horus secrets` if needed.)'));
  return 0;
}

/** `horus notify <subcommand>` dispatcher. */
export async function runNotify(sub: string | undefined, opts: NotifyOptions): Promise<number> {
  switch (sub) {
    case 'set':
      return runSet(opts);
    case 'show':
    case undefined:
      return runShow(opts);
    case 'test':
      return runTest(opts);
    case 'remove':
    case 'clear':
      return runRemove(opts);
    default:
      console.error(pc.red(`Unknown subcommand "${sub}". Use: set | show | test | remove.`));
      return 1;
  }
}
