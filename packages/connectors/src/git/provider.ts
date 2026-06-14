/**
 * Git history provider for @horus/connectors (HOR-22).
 * Shells out to `git` via node:child_process execFile — this is intentional and
 * expected for the history connector (the "no CLI shell-out" rule only applies
 * to Axon queries). See architecture.md §2.2.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  dateIso: string;
  subject: string;
  files: string[];
}

export interface GitLogOptions {
  since?: string;
  until?: string;
  maxCount?: number;
}

/**
 * Pure parser for `git log` stdout.
 * Each commit block starts with a line containing  (unit separator) as the
 * field delimiter in the --pretty=format string. Subsequent non-empty lines (up
 * to the next header line or end of input) are file paths from --name-only.
 */
export function parseGitLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];

  if (!stdout.trim()) return commits;

  const lines = stdout.split('\n');

  let current: GitCommit | null = null;

  for (const line of lines) {
    if (line.includes('')) {
      // Push the previous commit before starting a new one.
      if (current !== null) {
        commits.push(current);
      }
      const parts = line.split('');
      const sha = parts[0] ?? '';
      const shortSha = parts[1] ?? '';
      const author = parts[2] ?? '';
      const dateIso = parts[3] ?? '';
      const subject = parts[4] ?? '';
      current = { sha, shortSha, author, dateIso, subject, files: [] };
    } else if (line.trim() !== '') {
      // Non-empty line after the header — it's a file path.
      if (current !== null) {
        current.files.push(line.trim());
      }
    }
  }

  // Push the last commit.
  if (current !== null) {
    commits.push(current);
  }

  return commits;
}

/**
 * Fetch git log for `repoPath` with optional time-window and commit-count limits.
 * Returns commits in git order (newest first).
 */
export async function gitLog(
  repoPath: string,
  opts: GitLogOptions = {},
): Promise<GitCommit[]> {
  const args: string[] = [
    '-C',
    repoPath,
    'log',
    '--no-merges',
    '--pretty=format:%H%h%an%aI%s',
    '--name-only',
  ];

  if (opts.since !== undefined) {
    args.push('--since=' + opts.since);
  }
  if (opts.until !== undefined) {
    args.push('--until=' + opts.until);
  }
  args.push('--max-count=' + (opts.maxCount ?? 200));

  const { stdout } = await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });

  return parseGitLog(stdout);
}

/**
 * Returns true when the repo has at least one commit; false on any error
 * (e.g. path is not a git repo).
 */
export async function gitRepoHasCommits(repoPath: string): Promise<boolean> {
  try {
    return (await gitLog(repoPath, { maxCount: 1 })).length > 0;
  } catch {
    return false;
  }
}
