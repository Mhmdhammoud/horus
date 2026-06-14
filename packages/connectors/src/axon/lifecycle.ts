/**
 * Axon process lifecycle (HOR-37) — analyze a repo and host its graph.
 *
 * This shells out to the `axon` CLI for LIFECYCLE only (analyze / host), which is
 * explicitly allowed (like the git connector). The "no CLI shell-out" rule applies
 * to QUERIES — those still go over HTTP/MCP via AxonHttpClient.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, openSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const exec = promisify(execFile);

/** Is the `axon` binary on PATH? */
export async function axonAvailable(): Promise<boolean> {
  try {
    await exec('axon', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Has the repo been analyzed (a `.axon/` index exists)? */
export function isAnalyzed(root: string): boolean {
  return existsSync(join(root, '.axon'));
}

/** Run `axon analyze .` in the repo. Throws with stderr on failure. */
export async function analyzeRepo(root: string): Promise<void> {
  await exec('axon', ['analyze', '.'], {
    cwd: root,
    timeout: 900_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Is an Axon host reachable + healthy at this base URL? */
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

/**
 * Spawn `axon host --port <port>` as a detached background process in `root`,
 * logging to `.horus/axon-host.log`. Returns immediately — poll `waitForHost`.
 */
export function startHost(root: string, port: number): void {
  mkdirSync(join(root, '.horus'), { recursive: true });
  const logPath = join(root, '.horus', 'axon-host.log');
  const fd = openSync(logPath, 'a');
  const child = spawn('axon', ['host', '--port', String(port)], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
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
