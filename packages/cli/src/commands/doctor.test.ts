import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runDoctor } from './doctor.js';

describe('runDoctor', () => {
  const dirs: string[] = [];

  function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'horus-doctor-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('exits 0 in a fully configured repo (healthy case)', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [
            { name: 'test-project', path: root, axon: { hostUrl: 'http://127.0.0.1:8420' } },
          ],
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn, not fail) when local config is missing', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    // No .horus/config.json — missing setup case
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when not in a git repository', async () => {
    const root = tempDir();
    // No git init
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });

  it('exits 0 (warn) when source-intelligence host is not configured', async () => {
    const root = tempDir();
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
    mkdirSync(join(root, '.horus'));
    writeFileSync(
      join(root, '.horus', 'config.json'),
      JSON.stringify({
        version: 1,
        project: {
          name: 'test-project',
          repositories: [{ name: 'test-project', path: root }], // no axon
          environments: [{ name: 'production', readOnly: true, connectors: {} }],
        },
      }),
    );
    const code = await runDoctor({ cwd: root });
    expect(code).toBe(0);
  });
});
