/**
 * Passive update notifier (HOR-383).
 *
 * On a normal command run, print a one-line hint to STDERR when the CLI is behind the latest
 * GitHub release. The decision is made from a ~24h-cached result, so it NEVER blocks on the
 * network; the cache is refreshed in the background (fire-and-forget) for the next run. Fully
 * suppressed for non-interactive / CI / `--json` / opt-out so it can't corrupt machine output.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { HORUS_VERSION } from '@horus/core';
import { isNewer } from '../commands/update.js';

const CACHE_PATH = join(homedir(), '.horus', 'update-check.json');
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASES_API = 'https://api.github.com/repos/meritt-dev/horus/releases/latest';
const FETCH_TIMEOUT_MS = 2500;

export interface UpdateCache {
  lastCheckMs: number;
  latest: string;
}

/** Reasons to stay silent: explicit opt-out, CI, non-interactive stderr, or JSON output. */
export function isSuppressed(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stderr.isTTY),
  argv: string[] = process.argv,
): boolean {
  if (env['HORUS_NO_UPDATE_CHECK']) return true;
  if (env['CI']) return true;
  if (!isTTY) return true;
  if (argv.includes('--json')) return true;
  return false;
}

/** The one-line dim hint shown when the CLI is behind the latest release. */
export function formatHint(latest: string, current: string): string {
  return (
    pc.dim(`  A newer Horus is available: ${latest} (you're on ${current}). Run \`horus update\`.`) +
    '\n'
  );
}

function readCache(path: string): UpdateCache | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof j['latest'] === 'string' && typeof j['lastCheckMs'] === 'number') {
      return { latest: j['latest'], lastCheckMs: j['lastCheckMs'] };
    }
  } catch {
    /* missing / unreadable — treat as no cache */
  }
  return null;
}

function writeCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Pure decision (testable): given the cache, the current version, and now — what hint (if any)
 * should print, and is a background refresh due? Never throws (an unparseable version → silent).
 */
export function decideNotification(
  cache: UpdateCache | null,
  current: string,
  nowMs: number,
): { hint: string | null; refreshDue: boolean } {
  let hint: string | null = null;
  if (cache && cache.latest) {
    try {
      if (isNewer(cache.latest, current)) hint = formatHint(cache.latest, current);
    } catch {
      /* current is not a real release version (e.g. 'dev') — stay silent */
    }
  }
  const refreshDue = cache === null || nowMs - cache.lastCheckMs > CHECK_INTERVAL_MS;
  return { hint, refreshDue };
}

async function refresh(path: string, nowMs: number): Promise<void> {
  // Throttle eagerly (synchronously, before the first await) so a fast-exiting command doesn't
  // re-hit the API every run even if the fetch below never completes.
  const prev = readCache(path);
  writeCache(path, { lastCheckMs: nowMs, latest: prev?.latest ?? '' });
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `horus/${HORUS_VERSION}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return;
    const body = (await res.json()) as { tag_name?: unknown };
    const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    if (latest) writeCache(path, { lastCheckMs: nowMs, latest });
  } catch {
    /* best-effort — never surface a network error to the user */
  }
}

/**
 * Print a cached update hint (non-blocking) and kick off a background refresh if the cache is
 * stale. Safe to call on every command — it must NEVER block, throw, or corrupt output.
 */
export function maybeNotifyUpdate(): void {
  try {
    if (isSuppressed()) return;
    const nowMs = Date.now();
    const cache = readCache(CACHE_PATH);
    const { hint, refreshDue } = decideNotification(cache, HORUS_VERSION, nowMs);
    if (hint) process.stderr.write(hint);
    if (refreshDue) void refresh(CACHE_PATH, nowMs);
  } catch {
    /* a notifier must never break a command */
  }
}
