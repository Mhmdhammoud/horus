/**
 * Source-intelligence process lifecycle (HOR-37) — analyze a repo and host its graph.
 *
 * This shells out to the `horus-source` CLI for LIFECYCLE only (analyze / host), which is
 * explicitly allowed (like the git connector). The "no CLI shell-out" rule applies
 * to QUERIES — those still go over HTTP/MCP via SourceHttpClient.
 *
 * The binary is named `horus-source` (PyPI package `horus-source`); Horus exposes
 * lifecycle wrappers through source-boundary.ts (HOR-136, HOR-145).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, openSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);

/**
 * Preferred binary name, with `axon` as legacy fallback for users who have not yet
 * reinstalled the source-intelligence backend under the new Horus-owned name.
 */
const SOURCE_BINARIES = ['horus-source', 'axon'] as const;

/** Resolve the first available source-intelligence binary, or null if neither is on PATH. */
async function resolveSourceBin(): Promise<string | null> {
  for (const bin of SOURCE_BINARIES) {
    try {
      await exec(bin, ['--version'], { timeout: 5000 });
      return bin;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Is the source-intelligence backend binary (`horus-source` or legacy `axon`) on PATH? */
export async function axonAvailable(): Promise<boolean> {
  return (await resolveSourceBin()) !== null;
}

/**
 * Return the installed source-intelligence backend version string (e.g. "1.0.1"),
 * or null if no binary is on PATH or the version cannot be parsed.
 */
export async function getAxonVersion(): Promise<string | null> {
  for (const bin of SOURCE_BINARIES) {
    try {
      const { stdout } = await exec(bin, ['--version'], { timeout: 5000 });
      const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
      if (match?.[1]) return match[1];
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Has the repo been analyzed? Checks `.horus/source/` first, falls back to legacy `.axon/`. */
export function isAnalyzed(root: string): boolean {
  return existsSync(join(root, '.horus', 'source')) || existsSync(join(root, '.axon'));
}

/** Run `horus-source analyze .` (or legacy `axon analyze .`) in the repo. Throws on failure. */
export async function analyzeRepo(root: string): Promise<void> {
  const bin = await resolveSourceBin();
  if (!bin) throw new Error('Source-intelligence backend not found. Install horus-source.');
  await exec(bin, ['analyze', '.'], {
    cwd: root,
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Read the host URL the source-intelligence backend records for a repo
 * (`<root>/.axon/host.json`), if any. The backend runs at most ONE host per repo
 * (single-writer Kùzu lock), so this is the source of truth for "is this repo
 * already being hosted, and where". Different repos get different hosts/ports and
 * run concurrently. See also `readSourceHostUrl` (source-boundary.ts) for the
 * Horus-canonical 2-step lookup that prefers `.horus/source/host.json`.
 */
export function readAxonHostUrl(root: string): string | null {
  const p = join(root, '.axon', 'host.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { host_url?: unknown };
    return typeof j.host_url === 'string' ? j.host_url : null;
  } catch {
    return null;
  }
}

/** Is a source-intelligence host reachable + healthy at this base URL? */
export async function isHostHealthy(hostUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${hostUrl}/api/health`, {
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Find a free localhost TCP port in [start, end]. */
export async function findFreePort(start = 8420, end = 8520): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port available in ${start}-${end}`);
}

export interface SpawnedHostRecord {
  pid: number;
  port: number;
  root: string;
  startedAt: string;
}

const SPAWNED_HOST_FILE = 'spawned-host.json';

/** Read the PID record Horus wrote when it spawned a source-intelligence host for `root`. */
export function readSpawnedHost(root: string): SpawnedHostRecord | null {
  const p = join(root, '.horus', SPAWNED_HOST_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SpawnedHostRecord;
  } catch {
    return null;
  }
}

/**
 * Spawn `horus-source host --port <port>` (or legacy `axon host --port <port>`) as a detached
 * background source-intelligence host in `root`, logging to `.horus/source-host.log`. Records
 * the PID in `.horus/spawned-host.json` for safe teardown. Returns immediately — poll `waitForHost`.
 */
export function startHost(root: string, port: number, bin = 'horus-source'): void {
  mkdirSync(join(root, '.horus'), { recursive: true });
  const logPath = join(root, '.horus', 'source-host.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(bin, ['host', '--port', String(port)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });

  // If the preferred binary is missing, retry with the legacy `axon` binary.
  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' && bin === 'horus-source') {
      startHost(root, port, 'axon');
    }
  });

  if (child.pid !== undefined) {
    const record: SpawnedHostRecord = {
      pid: child.pid,
      port,
      root,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(join(root, '.horus', SPAWNED_HOST_FILE), JSON.stringify(record, null, 2) + '\n');
  }
  child.unref();
}

/** Remove the spawned-host record for `root`, if it exists. */
export function removeSpawnedHostRecord(root: string): void {
  const p = join(root, '.horus', SPAWNED_HOST_FILE);
  try {
    unlinkSync(p);
  } catch {
    // Not present — nothing to clean up.
  }
}

/** Poll a host's health until it responds or the timeout elapses. */
export async function waitForHost(hostUrl: string, timeoutMs = 45_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHostHealthy(hostUrl)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
