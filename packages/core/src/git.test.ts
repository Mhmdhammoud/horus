import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectLocalChanges, getHeadSha, getCurrentBranch } from './git.js';

function git(args: string[], cwd: string): void {
  const r = spawnSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('collectLocalChanges', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-git-coll-'));
    git(['init'], root);
    git(['config', 'user.email', 'test@horus.local'], root);
    git(['config', 'user.name', 'Horus Test'], root);
    writeFileSync(join(root, 'README.md'), 'initial\n');
    git(['add', 'README.md'], root);
    git(['commit', '-m', 'initial commit'], root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns no-git-repo for a plain directory', () => {
    const plain = mkdtempSync(join(tmpdir(), 'horus-plain-'));
    try {
      const result = collectLocalChanges({ cwd: plain });
      expect(result.kind).toBe('no-git-repo');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('returns changed files and commits since baseRef', () => {
    writeFileSync(join(root, 'feature.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'README.md'), 'updated\n');
    git(['add', '.'], root);
    git(['commit', '-m', 'add feature and update README'], root);

    const result = collectLocalChanges({ cwd: root, baseRef: 'HEAD~1' });
    expect(result.kind).toBe('local-changes');
    if (result.kind !== 'local-changes') return;

    expect(result.baseRef).toBe('HEAD~1');
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]?.message).toBe('add feature and update README');

    const statuses = Object.fromEntries(result.changedFiles.map((f) => [f.path, f.status]));
    expect(statuses['feature.ts']).toBe('added');
    expect(statuses['README.md']).toBe('modified');
  });

  it('returns empty arrays when baseRef equals HEAD (no changes)', () => {
    const result = collectLocalChanges({ cwd: root, baseRef: 'HEAD' });
    expect(result.kind).toBe('local-changes');
    if (result.kind !== 'local-changes') return;
    expect(result.changedFiles).toHaveLength(0);
    expect(result.commits).toHaveLength(0);
  });

  it('captures deleted files', () => {
    git(['rm', 'README.md'], root);
    git(['commit', '-m', 'delete README'], root);

    const result = collectLocalChanges({ cwd: root, baseRef: 'HEAD~1' });
    expect(result.kind).toBe('local-changes');
    if (result.kind !== 'local-changes') return;

    const deleted = result.changedFiles.find((f) => f.path === 'README.md');
    expect(deleted?.status).toBe('deleted');
  });
});

describe('getHeadSha / getCurrentBranch', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-git-head-'));
    git(['init'], root);
    git(['config', 'user.email', 'test@horus.local'], root);
    git(['config', 'user.name', 'Horus Test'], root);
    git(['checkout', '-b', 'work'], root);
    writeFileSync(join(root, 'README.md'), 'initial\n');
    git(['add', 'README.md'], root);
    git(['commit', '-m', 'initial commit'], root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the HEAD sha and current branch', () => {
    expect(getHeadSha(root)).toMatch(/^[0-9a-f]{40}$/);
    expect(getCurrentBranch(root)).toBe('work');
  });

  it('returns null outside a git repo (never throws)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'horus-nogit-'));
    try {
      expect(getHeadSha(plain)).toBeNull();
      expect(getCurrentBranch(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
