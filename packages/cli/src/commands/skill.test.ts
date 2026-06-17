import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runSkillInstall,
  runSkillPrint,
  runSkillPath,
  generateSkillContent,
  getSkillInstallPath,
  skillContentLeaksSecrets,
  SUPPORTED_TARGETS,
} from './skill.js';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-skill-'));
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
// Content generation
// ---------------------------------------------------------------------------

describe('generateSkillContent', () => {
  it('includes horus investigate command for all targets', () => {
    for (const target of SUPPORTED_TARGETS) {
      const content = generateSkillContent(target);
      expect(content).toContain('horus investigate');
    }
  });

  it('includes all required command recipes', () => {
    const content = generateSkillContent('generic');
    const required = [
      'horus explain',
      'horus investigate',
      'horus queues',
      'horus logs',
      'horus state',
      'horus metrics',
      'horus changes',
      'horus replay',
      'horus ask',
      'horus postmortem',
      'horus owner',
      'horus score',
    ];
    for (const cmd of required) {
      expect(content, `missing: ${cmd}`).toContain(cmd);
    }
  });

  it('distinguishes deterministic evidence from AI reasoning', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('not infallible');
    expect(content).toContain('Do not invent runtime evidence');
  });

  it('explains how to handle missing evidence', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('Horus returns nothing');
  });

  it('includes read-only safety note', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('read-only');
    expect(content).toContain('never use Horus to mutate production');
  });

  it('includes hallucination warning', () => {
    const content = generateSkillContent('generic');
    expect(content).toContain('hallucinate');
  });

  it('claude target includes Claude Code integration notes', () => {
    const content = generateSkillContent('claude');
    expect(content).toContain('.claude/skills/horus.md');
  });

  it('non-claude targets do not include claude-specific notes', () => {
    for (const target of SUPPORTED_TARGETS.filter((t) => t !== 'claude')) {
      const content = generateSkillContent(target);
      expect(content).not.toContain('.claude/skills');
    }
  });
});

// ---------------------------------------------------------------------------
// Install paths
// ---------------------------------------------------------------------------

describe('getSkillInstallPath', () => {
  it('claude → .claude/skills/horus.md under cwd', () => {
    const p = getSkillInstallPath('claude', { cwd: '/projects/my-app' });
    expect(p).toBe('/projects/my-app/.claude/skills/horus.md');
  });

  it('generic → .horus/skills/horus-generic.md under cwd', () => {
    const p = getSkillInstallPath('generic', { cwd: '/projects/my-app' });
    expect(p).toBe('/projects/my-app/.horus/skills/horus-generic.md');
  });

  it('codex → .horus/skills/horus-codex.md under cwd', () => {
    const p = getSkillInstallPath('codex', { cwd: '/projects/my-app' });
    expect(p).toBe('/projects/my-app/.horus/skills/horus-codex.md');
  });

  it('claude --global → .claude/skills/horus.md under home', () => {
    const p = getSkillInstallPath('claude', { global: true });
    expect(p).toContain('.claude/skills/horus.md');
    expect(p).not.toContain('/projects');
  });
});

// ---------------------------------------------------------------------------
// runSkillInstall
// ---------------------------------------------------------------------------

describe('runSkillInstall — success', () => {
  it('exits 0 and creates the skill file for claude target', async () => {
    const dir = tempDir();
    const code = await runSkillInstall('claude', { cwd: dir, write: () => {} });
    expect(code).toBe(0);
    const outPath = getSkillInstallPath('claude', { cwd: dir });
    expect(existsSync(outPath)).toBe(true);
  });

  it('exits 0 and creates the skill file for generic target', async () => {
    const dir = tempDir();
    const code = await runSkillInstall('generic', { cwd: dir, write: () => {} });
    expect(code).toBe(0);
    expect(existsSync(getSkillInstallPath('generic', { cwd: dir }))).toBe(true);
  });

  it('creates parent directories when they do not exist', async () => {
    const dir = tempDir();
    const code = await runSkillInstall('codex', { cwd: dir, write: () => {} });
    expect(code).toBe(0);
  });

  it('written content matches generated content', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    const content = readFileSync(outPath, 'utf8');
    expect(content).toBe(generateSkillContent('generic'));
  });

  it('prints the install path in the success message', async () => {
    const dir = tempDir();
    const { lines, code } = await capture((write) =>
      runSkillInstall('generic', { cwd: dir, write }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('.horus/skills');
  });
});

describe('runSkillInstall — overwrite protection', () => {
  it('exits 1 and refuses to overwrite without --force', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const code = await runSkillInstall('generic', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });

  it('preserves existing content without --force', async () => {
    const dir = tempDir();
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    writeFileSync(outPath, 'custom content', 'utf8');
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    expect(readFileSync(outPath, 'utf8')).toBe('custom content');
  });

  it('mentions --force in refusal message', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const { lines } = await capture((write) =>
      runSkillInstall('generic', { cwd: dir, write }),
    );
    expect(lines.join('\n')).toContain('--force');
  });

  it('exits 0 and overwrites with --force', async () => {
    const dir = tempDir();
    await runSkillInstall('generic', { cwd: dir, write: () => {} });
    const outPath = getSkillInstallPath('generic', { cwd: dir });
    writeFileSync(outPath, 'old content', 'utf8');
    const code = await runSkillInstall('generic', { cwd: dir, force: true, write: () => {} });
    expect(code).toBe(0);
    expect(readFileSync(outPath, 'utf8')).not.toBe('old content');
  });
});

describe('runSkillInstall — unknown target', () => {
  it('exits 1 for an unknown target', async () => {
    const dir = tempDir();
    const code = await runSkillInstall('unknown-agent', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });

  it('lists supported targets in the error message', async () => {
    const dir = tempDir();
    const { lines } = await capture((write) =>
      runSkillInstall('unknown-agent', { cwd: dir, write }),
    );
    expect(lines.join('\n')).toContain('claude');
    expect(lines.join('\n')).toContain('generic');
  });
});

// ---------------------------------------------------------------------------
// runSkillPath
// ---------------------------------------------------------------------------

describe('runSkillPath', () => {
  it('prints the install path and exits 0', async () => {
    const dir = tempDir();
    const { lines, code } = await capture((write) =>
      runSkillPath('claude', { cwd: dir, write }),
    );
    expect(code).toBe(0);
    expect(lines[0]).toContain('.claude/skills/horus.md');
  });

  it('exits 1 for an unknown target', async () => {
    const dir = tempDir();
    const code = await runSkillPath('unknown', { cwd: dir, write: () => {} });
    expect(code).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// No secret leakage
// ---------------------------------------------------------------------------

describe('skillContentLeaksSecrets', () => {
  it('returns false for normal skill content', () => {
    for (const target of SUPPORTED_TARGETS) {
      expect(skillContentLeaksSecrets(generateSkillContent(target))).toBe(false);
    }
  });

  it('returns true when content contains a password field', () => {
    expect(skillContentLeaksSecrets('"password": "hunter2"')).toBe(true);
  });

  it('returns true when content contains an apiKey field', () => {
    expect(skillContentLeaksSecrets('"apiKey": "sk-abc123def456"')).toBe(true);
  });

  it('returns true when content contains a MongoDB URI with credentials', () => {
    expect(
      skillContentLeaksSecrets('mongodb+srv://user:pass@cluster.mongodb.net/db'),
    ).toBe(true);
  });
});
