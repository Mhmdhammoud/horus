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

/** A single contributor's summary for a file, derived from git log. */
export interface FileContributor {
  author: string;
  commits: number;
  firstDate: string;
  lastDate: string;
}

/**
 * Pure parser for `git log --format=%an%x1f%aI` stdout.
 * Each line is 'authorISODATE'. Returns contributors sorted by commits
 * descending, then by lastDate descending.
 */
export function parseFileContributors(stdout: string): FileContributor[] {
  if (!stdout.trim()) return [];

  const tally = new Map<string, { commits: number; firstDate: string; lastDate: string }>();

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const sepIdx = trimmed.indexOf('');
    if (sepIdx === -1) continue;

    const author = trimmed.slice(0, sepIdx).trim();
    const date = trimmed.slice(sepIdx + 1).trim();

    if (!author || !date) continue;

    const existing = tally.get(author);
    if (existing === undefined) {
      tally.set(author, { commits: 1, firstDate: date, lastDate: date });
    } else {
      existing.commits += 1;
      if (date < existing.firstDate) existing.firstDate = date;
      if (date > existing.lastDate) existing.lastDate = date;
    }
  }

  const result: FileContributor[] = [];
  for (const [author, stats] of tally.entries()) {
    result.push({ author, ...stats });
  }

  result.sort((a, b) => {
    if (b.commits !== a.commits) return b.commits - a.commits;
    return b.lastDate < a.lastDate ? -1 : b.lastDate > a.lastDate ? 1 : 0;
  });

  return result;
}

/**
 * Fetch per-author contribution stats for a single file in a git repo.
 * Uses `--follow` to track renames. Returns an empty array on any error.
 */
export async function gitFileContributors(
  repoPath: string,
  file: string,
): Promise<FileContributor[]> {
  try {
    const { stdout } = await exec(
      'git',
      ['-C', repoPath, 'log', '--follow', '--format=%an%x1f%aI', '--', file],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return parseFileContributors(stdout);
  } catch {
    return [];
  }
}
