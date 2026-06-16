/**
 * Pure unit tests for parseFileContributors — no git process is spawned.
 */

import { describe, it, expect } from 'vitest';
import { parseFileContributors } from './provider.js';

// Unit separator character (\x1f) used in the --format=%an%x1f%ae%x1f%aI output.
const SEP = '\x1f';

// Helper: build a git-log line with name, email, and ISO date.
function line(name: string, email: string, date: string): string {
  return name + SEP + email + SEP + date;
}

describe('parseFileContributors', () => {
  it('returns an empty array for empty input', () => {
    expect(parseFileContributors('')).toEqual([]);
    expect(parseFileContributors('   \n  \n')).toEqual([]);
  });

  it('tallies commits per author and returns sorted by commits desc', () => {
    // 5 lines: Alice × 3, Bob × 2
    const stdout = [
      line('Alice', 'alice@example.com', '2024-03-01T10:00:00+00:00'),
      line('Bob', 'bob@example.com', '2024-03-02T11:00:00+00:00'),
      line('Alice', 'alice@example.com', '2024-03-05T09:00:00+00:00'),
      line('Bob', 'bob@example.com', '2024-02-20T08:00:00+00:00'),
      line('Alice', 'alice@example.com', '2024-01-15T07:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(2);

    const alice = result[0];
    expect(alice).toBeDefined();
    expect(alice?.author).toBe('Alice');
    expect(alice?.commits).toBe(3);
    expect(alice?.firstDate).toBe('2024-01-15T07:00:00+00:00');
    expect(alice?.lastDate).toBe('2024-03-05T09:00:00+00:00');

    const bob = result[1];
    expect(bob).toBeDefined();
    expect(bob?.author).toBe('Bob');
    expect(bob?.commits).toBe(2);
    expect(bob?.firstDate).toBe('2024-02-20T08:00:00+00:00');
    expect(bob?.lastDate).toBe('2024-03-02T11:00:00+00:00');
  });

  it('merges commits from the same email under different display names', () => {
    // Alice commits under two different display names — same email merges them.
    const stdout = [
      line('Alice', 'alice@example.com', '2024-01-01T10:00:00+00:00'),
      line('Alice B', 'alice@example.com', '2024-03-05T09:00:00+00:00'),
      line('Bob', 'bob@example.com', '2024-02-20T08:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(2);
    // Alice has 2 merged commits; display name comes from the most recent commit.
    expect(result[0]?.author).toBe('Alice B');
    expect(result[0]?.commits).toBe(2);
    expect(result[1]?.author).toBe('Bob');
    expect(result[1]?.commits).toBe(1);
  });

  it('skips malformed lines with fewer than 3 fields', () => {
    const stdout = [
      line('Alice', 'alice@example.com', '2024-03-01T10:00:00+00:00'),
      'this-line-has-no-separator',
      'Alice' + SEP + '2024-03-05T09:00:00+00:00', // only 2 fields — skipped
      '',
      line('Alice', 'alice@example.com', '2024-03-05T09:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(1);
    const alice = result[0];
    expect(alice?.author).toBe('Alice');
    expect(alice?.commits).toBe(2);
  });

  it('skips lines with empty author or empty date', () => {
    const stdout = [
      SEP + 'x@x.com' + SEP + '2024-03-01T10:00:00+00:00', // empty name
      line('Bob', 'bob@example.com', ''),                     // empty date
      line('Carol', 'carol@example.com', '2024-03-10T12:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(1);
    expect(result[0]?.author).toBe('Carol');
  });

  it('breaks ties in commit count by lastDate descending', () => {
    // Both have 1 commit; the one with the more recent lastDate should come first.
    const stdout = [
      line('Alice', 'alice@example.com', '2024-01-10T10:00:00+00:00'),
      line('Bob', 'bob@example.com', '2024-06-01T10:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(2);
    // Bob has a later date so should sort first when commits are tied.
    expect(result[0]?.author).toBe('Bob');
    expect(result[1]?.author).toBe('Alice');
  });

  it('falls back to name as key when email is empty', () => {
    const stdout = [
      line('Alice', '', '2024-03-01T10:00:00+00:00'),
      line('Alice', '', '2024-03-05T09:00:00+00:00'),
    ].join('\n');

    const result = parseFileContributors(stdout);

    expect(result).toHaveLength(1);
    expect(result[0]?.author).toBe('Alice');
    expect(result[0]?.commits).toBe(2);
  });
});
