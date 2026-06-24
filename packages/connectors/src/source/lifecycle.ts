/**
 * Source-intelligence process lifecycle (HOR-37) — analyze a repo and host its graph.
 *
 * This shells out to the `horus-source` CLI for LIFECYCLE only (analyze / host), which is
 * explicitly allowed (like the git connector). The "no CLI shell-out" rule applies
 * to QUERIES — those still go over HTTP/MCP via SourceHttpClient.
 *
 * The binary is named `horus-source` (PyPI package `horus-source`).
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, openSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { PINNED_SOURCE_VERSION } from '@horus/core';

const exec = promisify(execFile);

const SOURCE_BINARY = 'horus-source';

/** Resolve the source-intelligence binary, or null if it is not on PATH. */
export async function resolveSourceBin(): Promise<string | null> {
  try {
    await exec(SOURCE_BINARY, ['--version'], { timeout: 5000 });
    return SOURCE_BINARY;
  } catch {
    return null;
  }
}

/** Is the `horus-source` binary on PATH? */
export async function sourceAvailable(): Promise<boolean> {
  return (await resolveSourceBin()) !== null;
}

/** Resolve the active source-intelligence binary name, or null if not installed. */
export function getActiveSourceBin(): Promise<string | null> {
  return resolveSourceBin();
}

/**
 * Return the installed `horus-source` version string (e.g. "1.0.1"),
 * or null if the binary is not on PATH or the version cannot be parsed.
 */
export async function getSourceVersion(): Promise<string | null> {
  try {
    const { stdout } = await exec(SOURCE_BINARY, ['--version'], { timeout: 5000 });
    const match = stdout.trim().match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Thrown when the installed `horus-source` backend does not match {@link PINNED_SOURCE_VERSION}.
 * Carries both versions so callers can render an actionable, copy-pasteable remediation.
 */
export class SourceVersionMismatchError extends Error {
  constructor(
    public readonly installed: string,
    public readonly pinned: string,
  ) {
    super(
      `horus-source ${installed} is installed but Horus is pinned to ${pinned}. ` +
        `A drifted backend builds a graph this CLI cannot map and can corrupt the index ` +
        `(e.g. duplicate-primary-key failures during "Running initial index"). ` +
        `Install the pinned version: pip install 'horus-source==${pinned}'`,
    );
    this.name = 'SourceVersionMismatchError';
  }
}

/**
 * Assert the installed backend matches the pinned version BEFORE we let it analyze a repo
 * or host its graph (architecture.md §1, risk R4). A drifted build (an installed version
 * other than the pin) can build a Kùzu graph this CLI's query mapping does not expect, so
 * we refuse to launch it — failing loudly here instead of silently mis-mapping results.
 *
 * A version that cannot be read/parsed is allowed through (treated as "unknown", matching
 * how `horus status` reports it) — we only block on a *known* mismatch.
 *
 * @throws {SourceVersionMismatchError} when the installed version is known and differs.
 */
export async function assertSourceVersionPinned(): Promise<void> {
  const installed = await getSourceVersion();
  if (installed !== null && installed !== PINNED_SOURCE_VERSION) {
    throw new SourceVersionMismatchError(installed, PINNED_SOURCE_VERSION);
  }
}

/** Has the repo been analyzed? Checks `.horus/source/`. */
export function isAnalyzed(root: string): boolean {
  return existsSync(join(root, '.horus', 'source'));
}

/** Run `horus-source analyze .` in the repo. Throws on failure. */
export async function analyzeRepo(root: string): Promise<void> {
  const bin = await resolveSourceBin();
  if (!bin) throw new Error('horus-source not found on PATH. Install it: pip install horus-source');
  await exec(bin, ['analyze', '.'], {
    cwd: root,
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Return the host URL for the source-intelligence backend serving `root`, or null.
 * Reads from `.horus/source/host.json` — the canonical path written by horus-source.
 * The backend runs at most ONE host per repo (single-writer Kùzu lock), so this is
 * the source of truth for "is this repo already being hosted, and where". Different
 * repos get different hosts/ports and run concurrently.
 */
export function readSourceHostUrl(root: string): string | null {
  const p = join(root, '.horus', 'source', 'host.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { host_url?: unknown };
    return typeof j.host_url === 'string' ? j.host_url : null;
  } catch {
    return null;
  }
}

/**
 * The backend's own record of the host process it is running for `root`, read from
 * `.horus/source/host.json` (written by `horus-source host`). The `pid` here is the ACTUAL
 * listening server — which can differ from, and outlive, the spawn-wrapper pid Horus
 * records in `spawned-host.json`. Teardown needs this to signal the real process rather
 * than a stale wrapper pid. Returns null if the file is absent or malformed.
 */
export interface SourceHostRecord {
  pid: number;
  /** Port the backend reports it is serving on, or NaN if absent/invalid. */
  port: number;
  /** Repo the backend reports it is hosting, or '' if absent. */
  repoPath: string;
}

export function readSourceHostPid(root: string): SourceHostRecord | null {
  const p = join(root, '.horus', 'source', 'host.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as {
      pid?: unknown;
      port?: unknown;
      repo_path?: unknown;
    };
    if (typeof j.pid !== 'number' || !Number.isInteger(j.pid) || j.pid <= 0) return null;
    return {
      pid: j.pid,
      port: typeof j.port === 'number' ? j.port : NaN,
      repoPath: typeof j.repo_path === 'string' ? j.repo_path : '',
    };
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
 * Spawn `horus-source host --port <port>` as a detached background host in `root`,
 * logging to `.horus/source-host.log`. Records the PID in `.horus/spawned-host.json`
 * for safe teardown. Returns immediately — poll `waitForHost`.
 */
export function startHost(root: string, port: number): void {
  mkdirSync(join(root, '.horus'), { recursive: true });
  const logPath = join(root, '.horus', 'source-host.log');
  const fd = openSync(logPath, 'a');
  const child = spawn(SOURCE_BINARY, ['host', '--port', String(port)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });

  child.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      process.stderr.write(
        '\nhorus-source not found on PATH. Install it: pip install horus-source\n',
      );
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
