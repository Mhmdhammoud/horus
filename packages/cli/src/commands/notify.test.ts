import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runNotify } from './notify.js';

// `horus notify` resolves the repo root via findRepoRoot (needs a .git dir) and writes
// .horus/config.json. These tests drive runNotify directly in a throwaway git repo.

let root: string;
let configPath: string;
const origCwd = process.cwd();

function baseConfig(): unknown {
  return {
    version: 1,
    project: {
      name: 'demo',
      repositories: [{ name: 'demo', path: root, source: { hostUrl: 'http://127.0.0.1:8420' } }],
      environments: [{ name: 'production', readOnly: true, connectors: {} }],
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'horus-notify-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, '.horus'), { recursive: true });
  configPath = join(root, '.horus', 'config.json');
  writeFileSync(configPath, JSON.stringify(baseConfig(), null, 2));
  process.chdir(root);
  // Use an env-var master key so secret encryption needs no OS keychain in CI.
  process.env['HORUS_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
});

afterEach(() => {
  process.chdir(origCwd);
  delete process.env['HORUS_SECRET_KEY'];
  rmSync(root, { recursive: true, force: true });
});

describe('horus notify set', () => {
  it('writes the webhook url + threshold into config.json (non-secret)', async () => {
    const code = await runNotify('set', { url: 'https://hook.example/x', minConfidence: '0.7' });
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    const env = cfg.project.environments[0];
    expect(env.notify.webhook.url).toBe('https://hook.example/x');
    expect(env.notify.minConfidence).toBe(0.7);
  });

  it('does NOT write the signing secret as plaintext in config.json (encrypted store instead)', async () => {
    const code = await runNotify('set', { url: 'https://hook.example/x', secret: 'super-secret-value' });
    expect(code).toBe(0);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).not.toContain('super-secret-value');
    const cfg = JSON.parse(raw);
    expect(cfg.project.environments[0].notify.webhook.secret).toBeUndefined();
    // The encrypted secrets file exists and holds a ciphertext blob under the notify namespace.
    const secretsFile = join(root, '.horus', 'secrets.local.json');
    expect(existsSync(secretsFile)).toBe(true);
    const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
    expect(secrets.connectors.production.notify.webhookSecret).toBeDefined();
    expect(JSON.stringify(secrets)).not.toContain('super-secret-value');
  });

  it('rejects a missing or invalid url', async () => {
    expect(await runNotify('set', {})).toBe(1);
    expect(await runNotify('set', { url: 'not-a-url' })).toBe(1);
  });

  it('rejects an out-of-range --min-confidence', async () => {
    expect(await runNotify('set', { url: 'https://x.example', minConfidence: '1.5' })).toBe(1);
  });
});

describe('horus notify show / remove', () => {
  it('show reports "none" before set, the config after', async () => {
    expect(await runNotify('show', {})).toBe(0);
    await runNotify('set', { url: 'https://hook.example/y', cloud: true });
    expect(await runNotify('show', {})).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.project.environments[0].notify.cloud).toBe(true);
  });

  it('remove deletes the notify block', async () => {
    await runNotify('set', { url: 'https://hook.example/z' });
    expect(await runNotify('remove', {})).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(cfg.project.environments[0].notify).toBeUndefined();
  });
});
