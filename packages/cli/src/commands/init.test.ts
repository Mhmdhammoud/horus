/**
 * Tests for `horus init` (HOR-37 phase A) — the primary onboarding command.
 *
 * Pins the three side effects (local config written, project registered,
 * `.horus/` gitignored) and the next-steps guidance: init must point users at
 * `horus connect` for credentials, never at hand-editing connectors into
 * `.horus/config.json` (plaintext-secret footgun).
 *
 * HOME is redirected to a temp dir so the project registry never touches the
 * real `~/.horus/registry.json`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInit } from './init.js';

let home: string;
let repo: string;
let origHome: string | undefined;
let logs: string[];
let errs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'horus-init-home-'));
  repo = mkdtempSync(join(tmpdir(), 'horus-init-repo-'));
  origHome = process.env['HOME'];
  process.env['HOME'] = home;
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  process.env['HOME'] = origHome;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe('runInit', () => {
  it('writes .horus/config.json, registers the project, and gitignores .horus/', async () => {
    // ensureProjectGitignore only acts inside a git repo.
    mkdirSync(join(repo, '.git'));
    const code = await runInit({ name: 'demo-project', path: repo });

    expect(code).toBe(0);

    const configPath = join(repo, '.horus', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(config.version).toBe(1);
    expect(config.project.name).toBe('demo-project');
    expect(config.project.environments).toEqual([
      { name: 'production', readOnly: true, connectors: {} },
    ]);

    const registryPath = join(home, '.horus', 'registry.json');
    expect(existsSync(registryPath)).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    expect(registry.projects['demo-project']).toMatchObject({ configPath });

    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.horus/');
  });

  it('honors --env for the environment name', async () => {
    const code = await runInit({ name: 'demo-project', env: 'staging', path: repo });
    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(repo, '.horus', 'config.json'), 'utf8'));
    expect(config.project.environments[0].name).toBe('staging');
  });

  it('next steps recommend `horus connect`, never hand-editing connectors into config.json', async () => {
    const code = await runInit({ name: 'demo-project', path: repo });
    expect(code).toBe(0);

    const out = logs.join('\n');
    expect(out).toContain('horus connect');
    expect(out).not.toMatch(/add .*connectors.* to .*config\.json/);
  });

  it('returns 1 with an error message when the config cannot be written', async () => {
    // A regular file where a directory is expected makes writeLocalConfig throw.
    const notADir = join(repo, 'blocker');
    writeFileSync(notADir, '');

    const code = await runInit({ name: 'demo-project', path: join(notADir, 'nested') });

    expect(code).toBe(1);
    expect(errs.length).toBeGreaterThan(0);
  });
});
