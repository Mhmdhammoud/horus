/**
 * HOR-206 — `horus connect ai`: configure an AI narrative provider without editing
 * shell env. Stores the Anthropic API key (and/or a preferred local-CLI provider) in
 * `.horus/config.json` under a top-level `ai` block, redacted on display and gitignored
 * like every other credential. `horus investigate --ai` then works after setup.
 */

import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import {
  findRepoRoot,
  discoverLocalConfig,
  localConfigPath,
  readLocalConfig,
  writeLocalConfig,
  readLocalSecrets,
  writeLocalSecrets,
  ensureProjectGitignore,
  AI_PROVIDERS,
  type AiProvider,
  type LocalConfigFile,
} from '@horus/core';
import { LOCAL_PROVIDER_IDS, DEFAULT_LOCAL_PROVIDER_REGISTRY } from '@horus/ai';
import { ask, askPassword } from './connect.js';
import { isInteractive } from '../lib/tty-selector.js';

export interface ConnectAiOpts {
  config?: string;
  provider?: string;
  apiKey?: string;
  model?: string;
  noTest?: boolean;
}

/** Is a local provider CLI on PATH? */
function cliInstalled(id: string): boolean {
  const r = spawnSync(id, ['--version'], { stdio: 'ignore', timeout: 2000 });
  return !r.error;
}

/** Validate an Anthropic API key with a cheap authenticated GET /v1/models. */
async function probeAnthropic(apiKey: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true, detail: 'API key valid' };
    if (res.status === 401) return { ok: false, detail: 'invalid API key (401)' };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function redactKey(key: string): string {
  if (key.length <= 12) return '***';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}

export async function runConnectAi(opts: ConnectAiOpts): Promise<number> {
  try {
    const cwd = process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const configPath = discoverLocalConfig(cwd) ?? localConfigPath(root);

    // Surface which local provider CLIs are installed (context for the choice).
    const installed = LOCAL_PROVIDER_IDS.filter((id) => cliInstalled(id));
    console.log(pc.bold('\nAI providers'));
    console.log(
      pc.dim(
        `  Local CLIs on PATH: ${installed.length > 0 ? installed.join(', ') : 'none detected'}`,
      ),
    );
    console.log(pc.dim('  Cloud: anthropic (Anthropic Claude API — used by `investigate --ai`)\n'));

    // Resolve the provider.
    let provider = opts.provider as AiProvider | undefined;
    if (provider === undefined) {
      if (isInteractive()) {
        const answer = (
          await ask('Provider', 'anthropic', false)
        ).trim().toLowerCase();
        provider = (answer || 'anthropic') as AiProvider;
      } else {
        provider = 'anthropic';
      }
    }
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
      console.error(pc.red(`Unknown AI provider: ${provider}`) + pc.dim(`\n  supported: ${AI_PROVIDERS.join(', ')}`));
      return 1;
    }

    // Build the `ai` block.
    const aiBlock: Record<string, unknown> = { provider };
    let storedKey: string | undefined;

    if (provider === 'anthropic') {
      let apiKey = opts.apiKey;
      if (!apiKey && isInteractive()) {
        apiKey = (await askPassword('Anthropic API key')) || undefined;
      }
      if (!apiKey) {
        console.error(
          pc.red('No API key provided.') +
            pc.dim('\n  Pass --api-key sk-ant-… or set ANTHROPIC_API_KEY and re-run.'),
        );
        return 1;
      }
      if (!opts.noTest) {
        const probe = await probeAnthropic(apiKey);
        if (!probe.ok) {
          console.error(`\n${pc.red('✗ Anthropic key check failed:')} ${probe.detail}`);
          console.error(pc.dim('  Fix the key and retry, or pass --no-test to skip.'));
          return 1;
        }
        console.log(`\n${pc.green('✓')} anthropic ${pc.dim(`(${probe.detail})`)}`);
      }
      // The key goes to .horus/secrets.local.json (HOR-212), NOT config.json — only
      // the non-secret model preference is stored in the config's ai block.
      if (opts.model) aiBlock['anthropic'] = { model: opts.model };
      storedKey = apiKey;
    } else {
      // Local CLI provider — record the preference. Note the current limitation.
      if (!installed.includes(provider as (typeof LOCAL_PROVIDER_IDS)[number])) {
        console.error(
          pc.red(`${provider} CLI not found on PATH.`) +
            pc.dim(`\n  Install it first, or choose anthropic.`),
        );
        return 1;
      }
      const desc = DEFAULT_LOCAL_PROVIDER_REGISTRY.get(provider as (typeof LOCAL_PROVIDER_IDS)[number]);
      console.log(`\n${pc.green('✓')} ${desc?.displayName ?? provider} ${pc.dim('detected on PATH')}`);
      console.log(
        pc.dim(
          '  Note: `investigate --ai` currently uses the Anthropic API for narrative.\n' +
            '  Local-CLI narrative generation is recorded as your preference for future use.',
        ),
      );
    }

    // Persist into the local config's top-level `ai` block.
    const file: LocalConfigFile = discoverLocalConfig(cwd)
      ? readLocalConfig(configPath)
      : { version: 1, project: { name: root.split('/').pop() ?? 'project', repositories: [{ name: root.split('/').pop() ?? 'project', path: root }], environments: [{ name: 'production', readOnly: true, connectors: {} }] } };
    file.ai = aiBlock;
    writeLocalConfig(root, file);
    ensureProjectGitignore(root);
    // The API key is a secret — store it in .horus/secrets.local.json (gitignored),
    // never in config.json which a user may choose to share/commit (HOR-212).
    let secretsPathStr: string | undefined;
    if (storedKey !== undefined) {
      const existing = readLocalSecrets(root);
      secretsPathStr = writeLocalSecrets(root, {
        ...existing,
        anthropic: { ...(existing.anthropic ?? {}), apiKey: storedKey },
      });
    }

    console.log(`\n${pc.green('✓')} ${pc.bold('ai')} provider saved → ${pc.dim(configPath)}`);
    console.log(pc.dim(`  provider: ${provider}`));
    if (storedKey && secretsPathStr) {
      console.log(pc.dim(`  anthropic key: ${redactKey(storedKey)} → ${secretsPathStr} (gitignored)`));
    }
    console.log(pc.dim('  run: horus investigate "<hint>" --ai'));
    return 0;
  } catch (err) {
    console.error(pc.red(err instanceof Error ? err.message : String(err)));
    return 1;
  }
}
