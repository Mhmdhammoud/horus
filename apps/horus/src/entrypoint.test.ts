import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Workspace root is three directories above apps/horus/src/
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const TSX = resolve(WORKSPACE_ROOT, 'node_modules/.bin/tsx');
const ENTRYPOINT = resolve(__dirname, 'index.ts');
// Built release artifact — `tsup && vitest` in package.json ensures this exists.
const DIST = resolve(__dirname, '../dist/index.cjs');

// Guaranteed-absent config path: a unique temp dir is created, a .json file
// inside it is referenced but never written. Stays absent for the full suite.
let tmpDir: string;
let missingConfig: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'horus-smoke-'));
  missingConfig = join(tmpDir, 'config.json');
  // Deliberately do NOT create config.json — we want the file to be absent.
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

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
// Catches bundling, CJS conversion, and missing-dependency regressions that
// only surface in the installed product. The tsup build runs before vitest
// so this file is guaranteed to exist when these tests run.
describe('release artifact dist/index.cjs', () => {
  it('starts with the node shebang', () => {
    const head = readFileSync(DIST, 'utf8').slice(0, 64);
    expect(head).toContain('#!/usr/bin/env node');
  });

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

  // Command-handler routing: verify that routing reached the config-loading
  // path by asserting the output contains the exact config path we passed.
  // A generic crash would not include the path, so this distinguishes
  // "handler was reached and reported the error" from "unrelated exception".
  it('status with missing config exits non-zero and reports the config path', () => {
    const result = runDist('status', '--config', missingConfig);
    expect(result.status).not.toBe(0);
    // runStatus catches the ENOENT and prints via console.log to stdout.
    const output = result.stdout + result.stderr;
    expect(output).toContain(missingConfig);
  });

  it('investigate with missing config exits non-zero and reports the config path', () => {
    const result = runDist('investigate', 'test-hint', '--config', missingConfig);
    expect(result.status).not.toBe(0);
    // runInvestigate's outer catch prints via console.error to stderr.
    const output = result.stdout + result.stderr;
    expect(output).toContain(missingConfig);
  });
});
