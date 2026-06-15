/**
 * HOR-90 — Unit tests for `horus generate-config`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGenerateConfig } from './generate-config.js';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-gencfg-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function capture(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

// ---------------------------------------------------------------------------

describe('runGenerateConfig — new file', () => {
  it('exits 0 and creates horus.config.js in the target dir', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'horus.config.js');
    const code = await runGenerateConfig({ cwd: dir, write: () => {} });
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it('generated file is valid ESM with export default', async () => {
    const dir = tempDir();
    await runGenerateConfig({ cwd: dir, write: () => {} });
    const content = readFileSync(join(dir, 'horus.config.js'), 'utf8');
    expect(content).toContain('export default');
  });

  it('generated file contains the database url placeholder', async () => {
    const dir = tempDir();
    await runGenerateConfig({ cwd: dir, write: () => {} });
    const content = readFileSync(join(dir, 'horus.config.js'), 'utf8');
    expect(content).toContain('DATABASE_URL');
    expect(content).toContain('postgresql://horus:horus@localhost:5433/horus');
  });

  it('generated file uses the default project name placeholder', async () => {
    const dir = tempDir();
    await runGenerateConfig({ cwd: dir, write: () => {} });
    const content = readFileSync(join(dir, 'horus.config.js'), 'utf8');
    expect(content).toContain('my-project');
  });

  it('uses --name when provided', async () => {
    const dir = tempDir();
    await runGenerateConfig({ cwd: dir, name: 'leadcall-api', write: () => {} });
    const content = readFileSync(join(dir, 'horus.config.js'), 'utf8');
    expect(content).toContain('leadcall-api');
  });

  it('uses --repo when provided', async () => {
    const dir = tempDir();
    await runGenerateConfig({ cwd: dir, repo: '/repos/my-app', write: () => {} });
    const content = readFileSync(join(dir, 'horus.config.js'), 'utf8');
    expect(content).toContain('/repos/my-app');
  });

  it('writes to --out path when provided', async () => {
    const dir = tempDir();
    const custom = join(dir, 'config', 'custom.config.js');
    const code = await runGenerateConfig({ out: custom, write: () => {} });
    expect(code).toBe(0);
    expect(existsSync(custom)).toBe(true);
  });

  it('prints the created path in output', async () => {
    const dir = tempDir();
    const { lines, code } = await capture((write) => runGenerateConfig({ cwd: dir, write }));
    expect(code).toBe(0);
    const output = lines.join('\n');
    expect(output).toContain('Created');
    expect(output).toContain('horus.config.js');
  });

  it('prints a next-step hint pointing to doctor', async () => {
    const dir = tempDir();
    const { lines } = await capture((write) => runGenerateConfig({ cwd: dir, write }));
    expect(lines.join('\n')).toContain('horus doctor');
  });
});

// ---------------------------------------------------------------------------

describe('runGenerateConfig — overwrite protection', () => {
  it('exits 1 and refuses to overwrite an existing file', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'horus.config.js');
    writeFileSync(outPath, 'existing content', 'utf8');
    const code = await runGenerateConfig({ cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });

  it('preserves existing content when refused', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'horus.config.js');
    writeFileSync(outPath, 'existing content', 'utf8');
    await runGenerateConfig({ cwd: dir, write: () => {} });
    expect(readFileSync(outPath, 'utf8')).toBe('existing content');
  });

  it('mentions --force in the refusal message', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'horus.config.js'), 'existing', 'utf8');
    const { lines } = await capture((write) => runGenerateConfig({ cwd: dir, write }));
    expect(lines.join('\n')).toContain('--force');
  });

  it('exits 0 and overwrites when --force is passed', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'horus.config.js');
    writeFileSync(outPath, 'old content', 'utf8');
    const code = await runGenerateConfig({ cwd: dir, force: true, write: () => {} });
    expect(code).toBe(0);
    expect(readFileSync(outPath, 'utf8')).not.toBe('old content');
    expect(readFileSync(outPath, 'utf8')).toContain('export default');
  });
});
