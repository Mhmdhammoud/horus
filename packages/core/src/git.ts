import { spawnSync } from 'node:child_process';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface ChangedFile {
  path: string;
  /** Only set when status is 'renamed'. */
  oldPath?: string;
  status: FileStatus;
}

export interface CommitSummary {
  hash: string;
  message: string;
}

export interface LocalChangeSummary {
  kind: 'local-changes';
  baseRef: string;
  changedFiles: ChangedFile[];
  commits: CommitSummary[];
}

export interface NoGitRepo {
  kind: 'no-git-repo';
  cwd: string;
}

export type LocalChangeResult = LocalChangeSummary | NoGitRepo;

/**
 * Collect changed files and commits between `baseRef` and HEAD.
 * Returns `{ kind: 'no-git-repo' }` when `cwd` is not inside a git repository.
 * Never throws — git failures produce empty arrays.
 */
export function collectLocalChanges(opts?: {
  cwd?: string;
  baseRef?: string;
}): LocalChangeResult {
  const cwd = opts?.cwd ?? process.cwd();
  const baseRef = opts?.baseRef ?? 'HEAD~1';

  const gitCheck = spawnSync('git', ['rev-parse', '--git-dir'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (gitCheck.status !== 0) {
    return { kind: 'no-git-repo', cwd };
  }

  const changedFiles = parseDiff(
    spawnSync('git', ['diff', '--name-status', `${baseRef}..HEAD`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout ?? '',
  );

  const commits = parseLog(
    spawnSync('git', ['log', '--oneline', `${baseRef}..HEAD`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout ?? '',
  );

  return { kind: 'local-changes', baseRef, changedFiles, commits };
}

function parseDiff(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const raw = parts[0] ?? '';
    if (raw.startsWith('R')) {
      files.push({ path: parts[2] ?? parts[1] ?? '', oldPath: parts[1], status: 'renamed' });
    } else if (raw === 'A') {
      files.push({ path: parts[1] ?? '', status: 'added' });
    } else if (raw === 'D') {
      files.push({ path: parts[1] ?? '', status: 'deleted' });
    } else if (raw === 'M') {
      files.push({ path: parts[1] ?? '', status: 'modified' });
    }
  }
  return files;
}

function parseLog(stdout: string): CommitSummary[] {
  const commits: CommitSummary[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    commits.push({ hash: line.slice(0, sp), message: line.slice(sp + 1) });
  }
  return commits;
}
