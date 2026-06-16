/**
 * Bounded git change collector for investigation input (HOR-93).
 *
 * Accepts a repo path + a "since" value (duration, ISO date, or commit ref)
 * and returns a bounded summary of commits + per-file diff stats. Hard limits
 * on files, commits, and bytes prevent large repositories from generating
 * unbounded investigation input.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitLog } from '@horus/connectors';
import type { GitCommit } from '@horus/connectors';

const exec = promisify(execFile);

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_COMMITS = 50;
const DEFAULT_MAX_FILES = 100;
const DEFAULT_MAX_BYTES = 50_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GitChangeQuery {
  repoPath: string;
  /** Duration ("24 hours ago", "2 days ago"), ISO date, or commit ref/SHA. */
  since: string;
  until?: string;
  maxCommits?: number;
  maxFiles?: number;
  /** Byte cap on the total serialised size of fileStats entries. */
  maxBytes?: number;
}

export interface FileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export interface BoundedGitChange {
  commits: GitCommit[];
  fileStats: FileStat[];
  changedFiles: string[];
  totalInsertions: number;
  totalDeletions: number;
  window: { since: string; until: string | undefined };
  truncated: boolean;
  truncatedReason?: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Return true when `s` looks like a git ref (SHA or ref name) rather than a
 * date/duration.  Conservative: only matches hex-only strings (7–40 chars) or
 * slash-free single-word tokens that are not purely numeric or time-like.
 * Date/time strings always contain a colon, space, dash sequence, or the word
 * "ago" — those are excluded.
 */
export function isRefLike(s: string): boolean {
  const t = s.trim();
  // Reject flag-like strings and range notation embedded in a ref value.
  if (t.startsWith('-')) return false;
  if (t.includes('..')) return false;
  // ISO date, "N days ago", "N hours ago", "yesterday", etc.
  if (/\s|:|ago|yesterday|week|month|year|=/i.test(t)) return false;
  // Duration strings like "24h", "7d", "30m", "90s" — log window specifiers,
  // not git refs.
  if (/^\d+[smhd]$/i.test(t)) return false;
  // Pure hex SHA (7–40 chars)
  if (/^[0-9a-f]{7,40}$/i.test(t)) return true;
  // Named ref: branch, tag, or relative ref notation (HEAD~5, v1.2~3, etc.).
  // Allows ~^- in addition to the base alphanumeric+./_ set.
  if (/^[a-zA-Z0-9_.~^/-]{1,200}$/.test(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t)) return true;
  return false;
}

/**
 * Parse `git diff --stat` or `git diff --shortstat` output into FileStat[].
 * Lines look like: " path/to/file.ts | 12 ++++----"
 * The summary line ("N files changed, X insertions(+)…") is skipped.
 */
export function parseDiffStat(stdout: string): FileStat[] {
  const stats: FileStat[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || /^\d+ files? changed/.test(trimmed)) continue;

    // Format: "path | N +++---" or "path | Bin 0 -> N bytes"
    const pipeIdx = trimmed.lastIndexOf('|');
    if (pipeIdx === -1) continue;

    const path = trimmed.slice(0, pipeIdx).trim();
    const rest = trimmed.slice(pipeIdx + 1).trim();

    if (!path || rest.includes('Bin')) continue;

    const insertions = (rest.match(/\+/g) ?? []).length;
    const deletions = (rest.match(/-/g) ?? []).length;
    stats.push({ path, insertions, deletions });
  }
  return stats;
}

// ── Core function ─────────────────────────────────────────────────────────────

/**
 * Collect bounded git changes for investigation input.
 * Never throws — errors produce a result with truncated=true and an error reason.
 */
export async function collectGitChanges(query: GitChangeQuery): Promise<BoundedGitChange> {
  const maxCommits = query.maxCommits ?? DEFAULT_MAX_COMMITS;
  const maxFiles = query.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = query.maxBytes ?? DEFAULT_MAX_BYTES;

  const empty = (reason?: string): BoundedGitChange => ({
    commits: [],
    fileStats: [],
    changedFiles: [],
    totalInsertions: 0,
    totalDeletions: 0,
    window: { since: query.since, until: query.until },
    truncated: reason !== undefined,
    truncatedReason: reason,
  });

  // ── Input validation (security: prevent argv flag smuggling) ─────────────────

  if (!query.repoPath.startsWith('/')) {
    return empty('repoPath must be an absolute path');
  }
  if (query.until !== undefined && isRefLike(query.since) && !isRefLike(query.until)) {
    return empty(`invalid until ref: ${query.until.slice(0, 60)}`);
  }

  // ── 1. Fetch commits ───────────────────────────────────────────────────────

  let commits: GitCommit[];
  try {
    if (isRefLike(query.since)) {
      // Ref-based: use <ref>..HEAD range with an extra arg so gitLog doesn't
      // add --since. We call git directly with the range syntax.
      const args = [
        '-C', query.repoPath,
        'log',
        '--no-merges',
        `--pretty=format:%H%h%an%aI%s`,
        '--name-only',
        `--max-count=${maxCommits}`,
        `${query.since}..${query.until ?? 'HEAD'}`,
      ];
      const { stdout } = await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });
      commits = parseRefRangeLog(stdout);
    } else {
      commits = await gitLog(query.repoPath, {
        since: query.since,
        until: query.until,
        maxCount: maxCommits,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return empty(`git log failed: ${msg.slice(0, 120)}`);
  }

  if (commits.length === 0) return empty();

  const truncatedCommits = commits.length >= maxCommits;

  // ── 2. Fetch diff stats ────────────────────────────────────────────────────

  let rawStats: FileStat[] = [];
  try {
    const oldest = commits[commits.length - 1];
    if (oldest !== undefined) {
      const rangeBase = isRefLike(query.since) ? query.since : `${oldest.sha}^`;
      // query.until already validated above when isRefLike(query.since) is true.
      const rangeHead = query.until ?? 'HEAD';
      const { stdout } = await exec(
        'git',
        ['-C', query.repoPath, 'diff', '--stat', `${rangeBase}..${rangeHead}`],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      rawStats = parseDiffStat(stdout);
    }
  } catch {
    // Diff stats are best-effort; proceed without them
  }

  // ── 3. Apply file and byte limits ─────────────────────────────────────────

  let fileStats = rawStats;
  let truncatedFiles = false;
  let truncatedBytes = false;

  if (fileStats.length > maxFiles) {
    fileStats = fileStats.slice(0, maxFiles);
    truncatedFiles = true;
  }

  // Byte cap: measure the serialised representation of each FileStat entry.
  let byteCount = 0;
  const bounded: FileStat[] = [];
  for (const s of fileStats) {
    const entrySize = s.path.length + 30; // path + numbers + overhead
    if (byteCount + entrySize > maxBytes) {
      truncatedBytes = true;
      break;
    }
    byteCount += entrySize;
    bounded.push(s);
  }
  fileStats = bounded;

  // ── 4. Aggregate totals ────────────────────────────────────────────────────

  let totalInsertions = 0;
  let totalDeletions = 0;
  for (const s of fileStats) {
    totalInsertions += s.insertions;
    totalDeletions += s.deletions;
  }

  // Unique changed files from commits (capped to maxFiles)
  const fileSet = new Set<string>();
  for (const c of commits) {
    for (const f of c.files) {
      fileSet.add(f);
      if (fileSet.size >= maxFiles) break;
    }
    if (fileSet.size >= maxFiles) break;
  }
  const changedFiles = [...fileSet];

  const truncated = truncatedCommits || truncatedFiles || truncatedBytes;
  const reasons: string[] = [];
  if (truncatedCommits) reasons.push(`commits capped at ${maxCommits}`);
  if (truncatedFiles) reasons.push(`files capped at ${maxFiles}`);
  if (truncatedBytes) reasons.push(`output capped at ${maxBytes} bytes`);

  return {
    commits,
    fileStats,
    changedFiles,
    totalInsertions,
    totalDeletions,
    window: { since: query.since, until: query.until },
    truncated,
    truncatedReason: reasons.length > 0 ? reasons.join('; ') : undefined,
  };
}

// ── Internal: ref-range log parser ────────────────────────────────────────────

function parseRefRangeLog(stdout: string): GitCommit[] {
  const commits: GitCommit[] = [];
  if (!stdout.trim()) return commits;

  const lines = stdout.split('\n');
  let current: GitCommit | null = null;

  for (const line of lines) {
    if (line.includes('')) {
      if (current !== null) commits.push(current);
      const parts = line.split('');
      current = {
        sha: parts[0] ?? '',
        shortSha: parts[1] ?? '',
        author: parts[2] ?? '',
        dateIso: parts[3] ?? '',
        subject: parts[4] ?? '',
        files: [],
      };
    } else if (line.trim() !== '' && current !== null) {
      current.files.push(line.trim());
    }
  }
  if (current !== null) commits.push(current);
  return commits;
}
