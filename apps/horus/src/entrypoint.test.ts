import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Workspace root is three directories above apps/horus/src/
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const TSX = resolve(WORKSPACE_ROOT, 'node_modules/.bin/tsx');
const ENTRYPOINT = resolve(__dirname, 'index.ts');
// Built release artifact — `tsup && vitest` in package.json ensures this exists.
const DIST = resolve(__dirname, '../dist/index.cjs');

function runCLI(...args: string[]) {
  return spawnSync(TSX, [ENTRYPOINT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 15_000,
    cwd: WORKSPACE_ROOT,
  });
}

function runDist(...args: string[]) {
  return spawnSync(process.execPath, [DIST, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
    timeout: 15_000,
    cwd: WORKSPACE_ROOT,
  });
}

// ── Source entrypoint (tsx) ───────────────────────────────────────────────────
// Fast path: catches API/logic regressions without requiring a build step.
describe('source entrypoint via tsx', () => {
  it('--version exits 0 and prints version', () => {
    const result = runCLI('--version');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/horus \d+\.\d+\.\d+/);
  });

  it('--help exits 0 and includes the program name', () => {
    const result = runCLI('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('horus');
  });

  it('--help lists release-critical commands', () => {
    const out = runCLI('--help').stdout;
    for (const cmd of ['setup', 'investigate', 'index', 'connect', 'stop', 'hosts']) {
      expect(out, `--help should mention "${cmd}"`).toContain(cmd);
    }
  });

  it('setup --help exits 0', () => {
    const result = runCLI('setup', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('setup');
  });

  it('index --help exits 0', () => {
    const result = runCLI('index', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('index');
  });

  it('investigate --help exits 0 and documents --format', () => {
    const result = runCLI('investigate', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('format');
  });

  it('connect --help exits 0', () => {
    expect(runCLI('connect', '--help').status).toBe(0);
  });

  it('hosts --help exits 0', () => {
    expect(runCLI('hosts', '--help').status).toBe(0);
  });

  it('stop --help exits 0', () => {
    expect(runCLI('stop', '--help').status).toBe(0);
  });

  it('<unknown-command> exits non-zero', () => {
    expect(runCLI('this-command-does-not-exist').status).not.toBe(0);
  });
});

// ── Release artifact (dist/index.cjs) ────────────────────────────────────────
// Catches bundling, CJS conversion, shebang, or missing-dependency regressions
// that only surface in the installed product. The tsup build runs before vitest
// so this file is guaranteed to exist when these tests run.
describe('release artifact dist/index.cjs', () => {
  it('--version exits 0 and prints version', () => {
    const result = runDist('--version');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/horus \d+\.\d+\.\d+/);
  });

  it('--help exits 0 and includes the program name', () => {
    const result = runDist('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('horus');
  });

  it('--help lists release-critical commands', () => {
    const out = runDist('--help').stdout;
    for (const cmd of ['setup', 'investigate', 'index', 'connect', 'stop', 'hosts']) {
      expect(out, `--help should mention "${cmd}"`).toContain(cmd);
    }
  });

  it('investigate --help exits 0 and documents --format', () => {
    const result = runDist('investigate', '--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('format');
  });

  it('<unknown-command> exits non-zero', () => {
    expect(runDist('this-command-does-not-exist').status).not.toBe(0);
  });

  // Command-handler routing: invoke a real command without any config and assert
  // it exits non-zero with output, not a silent crash. A non-existent config path
  // forces the failure predictably regardless of local machine state.
  it('status with missing config file exits non-zero', () => {
    const result = runDist('status', '--config', '/tmp/horus-smoke-nonexistent.json');
    expect(result.status).not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output.length, 'should produce error output, not crash silently').toBeGreaterThan(0);
  });

  it('investigate with missing config file exits non-zero', () => {
    const result = runDist('investigate', 'test-hint', '--config', '/tmp/horus-smoke-nonexistent.json');
    expect(result.status).not.toBe(0);
  });
});
