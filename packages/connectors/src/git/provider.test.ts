/**
 * Pure unit tests for parseGitLog — no git process is spawned.
 */

import { describe, it, expect } from 'vitest';
import { parseGitLog } from './provider.js';

// Unit separator character used in the --pretty=format string.
const SEP = '';

describe('parseGitLog', () => {
  it('returns an empty array for empty stdout', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('   \n  \n')).toEqual([]);
  });

  it('parses two commits with correct fields and files', () => {
    // Simulate what `git log --pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s --name-only`
    // produces for two commits (newest first), separated by a blank line.
    const stdout = [
      `abc123fullsha${SEP}abc123${SEP}Alice${SEP}2024-01-15T10:00:00+00:00${SEP}feat: add payment flow`,
      'src/payments/index.ts',
      'src/payments/types.ts',
      '',
      `def456fullsha${SEP}def456${SEP}Bob${SEP}2024-01-14T09:00:00+00:00${SEP}fix: handle timeout`,
      'src/utils/timeout.ts',
    ].join('\n');

    const commits = parseGitLog(stdout);

    expect(commits).toHaveLength(2);

    const first = commits[0];
    expect(first).toBeDefined();
    expect(first?.sha).toBe('abc123fullsha');
    expect(first?.shortSha).toBe('abc123');
    expect(first?.author).toBe('Alice');
    expect(first?.dateIso).toBe('2024-01-15T10:00:00+00:00');
    expect(first?.subject).toBe('feat: add payment flow');
    expect(first?.files).toEqual(['src/payments/index.ts', 'src/payments/types.ts']);

    const second = commits[1];
    expect(second).toBeDefined();
    expect(second?.sha).toBe('def456fullsha');
    expect(second?.shortSha).toBe('def456');
    expect(second?.author).toBe('Bob');
    expect(second?.dateIso).toBe('2024-01-14T09:00:00+00:00');
    expect(second?.subject).toBe('fix: handle timeout');
    expect(second?.files).toEqual(['src/utils/timeout.ts']);
  });

  it('handles a commit with no changed files', () => {
    const stdout =
      `deadbeefdeadbeef${SEP}deadbeef${SEP}Carol${SEP}2024-01-13T08:00:00+00:00${SEP}chore: bump version`;

    const commits = parseGitLog(stdout);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual([]);
  });

  it('trims whitespace from file paths', () => {
    const stdout = [
      `aaabbbcccddd${SEP}aaabbb${SEP}Dave${SEP}2024-01-12T07:00:00+00:00${SEP}refactor: cleanup`,
      '  src/foo.ts  ',
    ].join('\n');

    const commits = parseGitLog(stdout);
    expect(commits[0]?.files).toEqual(['src/foo.ts']);
  });
});
