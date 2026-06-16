/**
 * `horus stop` — stop the source-intelligence host(s) spawned by Horus for the
 * current repo (HOR-41). Stopping is never required for correctness — per-repo
 * hosts are independent. This is ergonomics/resource hygiene.
 *
 * Safety model:
 *  1. Read `.horus/spawned-host.json` (written by `startHost` at spawn time).
 *  2. Verify the PID's full argument string contains `horus-source host --port <port>`
 *     (handles Python-backed executables where comm= returns the interpreter).
 *  3. Guard against PID reuse: compare the process's elapsed time (etimes=)
 *     against the recorded startedAt, rejecting divergences > 60 s.
 *  4. Only then send SIGTERM.
 *  5. Remove the spawned-host record on success.
 *
 * No fallback to an unowned lsof-discovered PID is provided — we will not
 * signal a process we cannot prove Horus spawned.
 */

import { execFile } from 'node:child_process';
import { unlink } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import pc from 'picocolors';
import { findRepoRoot, readRegistry, HORUS_DIR } from '@horus/core';
import { readSourceHostUrl, isHostHealthy, readSpawnedHost, type SpawnedHostRecord } from '@horus/connectors';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(unlink);

export interface StopOpts {
  all?: boolean;
}

const SPAWNED_HOST_FILE = 'spawned-host.json';
/** Tolerated drift between recorded start time and measured elapsed time (seconds). */
const START_TIME_TOLERANCE_S = 60;

export async function runStop(opts: StopOpts): Promise<number> {
  try {
    if (opts.all) {
      return await stopAll();
    }
    const cwd = process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const hostUrl = readSourceHostUrl(root);
    if (!hostUrl) {
      console.log(pc.dim('No source-intelligence host found for this repo (.horus/source/host.json absent).'));
      return 0;
    }
    return await stopHost(root, hostUrl);
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

async function stopHost(root: string, hostUrl: string): Promise<number> {
  const alive = await isHostHealthy(hostUrl);
  if (!alive) {
    console.log(pc.dim(`Host ${hostUrl} is already stopped.`));
    return 0;
  }

  const port = extractPort(hostUrl);
  if (port === null) {
    console.error(pc.red(`Cannot determine port from host URL: ${hostUrl}`));
    return 1;
  }

  const spawned = readSpawnedHost(root);
  if (spawned === null) {
    console.error(
      pc.red(
        `No ownership record found (.horus/${SPAWNED_HOST_FILE} absent). ` +
          'Horus will not stop a host it did not spawn.',
      ),
    );
    return 1;
  }

  // --- validate record structure before using any value from it ---
  const recordError = validateSpawnedRecord(spawned);
  if (recordError !== null) {
    console.error(pc.red(`Ownership record is malformed: ${recordError}. Aborting for safety.`));
    return 1;
  }

  if (spawned.port !== port) {
    console.error(
      pc.red(
        `Ownership record port (${spawned.port}) does not match host URL port (${port}). ` +
          'Record may be stale.',
      ),
    );
    return 1;
  }

  if (spawned.root !== root) {
    console.error(
      pc.red(
        `Ownership record root (${spawned.root}) does not match resolved root (${root}). ` +
          'Record may be stale.',
      ),
    );
    return 1;
  }

  // --- verify process identity ---
  const info = await getProcessInfo(spawned.pid);
  if (info === null) {
    console.error(pc.red(`Process pid ${spawned.pid} is no longer running.`));
    return 1;
  }

  // Match `horus-source host --port <port>`.
  // Requirements for the pattern:
  //  - Optional path prefix: handles /home/user/.local/bin/horus-source (Python entrypoint)
  //  - binary then `host` then `--port` in that ORDER (not independent substrings)
  //  - Port must be followed by \s or EOL so 8420 does not match 84200
  //  - port comes from parseInt so it has no regex metacharacters
  const portStr = String(port);
  const hostPortRe = new RegExp(
    `(?:^|\\s)(?:\\S*/)?horus-source\\s+host\\s+--port(?:=|\\s+)${portStr}(?=\\s|$)`,
  );
  if (!hostPortRe.test(info.args)) {
    console.error(
      pc.red(
        `Pid ${spawned.pid} args do not match "horus-source host --port ${portStr}". ` +
          `Got: "${info.args.slice(0, 120)}". Aborting for safety.`,
      ),
    );
    return 1;
  }

  // Elapsed time check: guard against PID reuse.
  // validateSpawnedRecord() guarantees startedAt parses to a valid past timestamp,
  // so startTs is finite and < Date.now().
  const startTs = new Date(spawned.startedAt).getTime();
  const recordedAgeS = Math.round((Date.now() - startTs) / 1000);
  if (!Number.isFinite(info.etimeSeconds)) {
    console.error(pc.red(`Could not read elapsed time for pid ${spawned.pid}. Aborting for safety.`));
    return 1;
  }
  if (Math.abs(info.etimeSeconds - recordedAgeS) > START_TIME_TOLERANCE_S) {
    console.error(
      pc.red(
        `Pid ${spawned.pid} age mismatch: record says ~${recordedAgeS}s, ` +
          `process reports ${info.etimeSeconds}s elapsed. Possible PID reuse — aborting for safety.`,
      ),
    );
    return 1;
  }

  try {
    process.kill(spawned.pid, 'SIGTERM');
    console.log(
      `${pc.green('✓')} Stopped source-intelligence host ` +
        pc.dim(`(pid ${spawned.pid}, port ${port})`) +
        ` for ${root}`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      console.log(pc.dim(`Host already gone (pid ${spawned.pid}).`));
    } else {
      console.error(pc.red(`Failed to signal pid ${spawned.pid}: ${(err as Error).message}`));
      return 1;
    }
  }

  // Remove ownership record so stale entries don't confuse future runs.
  try {
    await unlinkAsync(join(root, HORUS_DIR, SPAWNED_HOST_FILE));
  } catch {
    // Not fatal — missing record is benign on the next invocation.
  }

  return 0;
}

async function stopAll(): Promise<number> {
  const registry = readRegistry();
  const projects = Object.entries(registry.projects);
  if (projects.length === 0) {
    console.log(pc.dim('No registered projects.'));
    return 0;
  }

  let stopped = 0;
  let failed = 0;
  for (const [name, entry] of projects) {
    const hostUrl = readSourceHostUrl(entry.root);
    if (!hostUrl) continue;
    const alive = await isHostHealthy(hostUrl);
    if (!alive) continue;
    console.log(`  Stopping ${pc.bold(name)} ${pc.dim(`(${hostUrl})`)}`);
    const code = await stopHost(entry.root, hostUrl);
    if (code === 0) stopped++;
    else failed++;
  }

  if (stopped === 0 && failed === 0) {
    console.log(pc.dim('No running source-intelligence hosts found.'));
  } else {
    console.log(
      `\nStopped ${stopped} host(s)${failed > 0 ? pc.red(`, ${failed} failed`) : ''}.`,
    );
  }
  return failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Record validation
// ---------------------------------------------------------------------------

/**
 * Structurally validate the spawned-host record before any value is used.
 * Returns a human-readable error string, or null if the record is valid.
 */
function validateSpawnedRecord(r: SpawnedHostRecord): string | null {
  if (!Number.isInteger(r.pid) || r.pid <= 0) {
    return `invalid pid ${r.pid}`;
  }
  if (!Number.isInteger(r.port) || r.port <= 0 || r.port > 65535) {
    return `invalid port ${r.port}`;
  }
  if (!r.root || typeof r.root !== 'string') {
    return 'root is empty or not a string';
  }
  if (!r.startedAt || typeof r.startedAt !== 'string') {
    return 'startedAt is missing or not a string';
  }
  const ts = new Date(r.startedAt).getTime();
  if (!Number.isFinite(ts)) {
    return `startedAt is not a valid date: "${r.startedAt}"`;
  }
  if (ts > Date.now()) {
    return `startedAt is in the future: "${r.startedAt}"`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Process info
// ---------------------------------------------------------------------------

interface ProcessInfo {
  args: string;
  etimeSeconds: number;
}

/**
 * Read the full argument string and elapsed time (in seconds) for a PID.
 * Returns null if the process does not exist or ps fails.
 *
 * Uses `ps -p <pid> -o args=,etimes=`:
 *  - `args=`  — full argv joined by spaces; handles Python-backed CLI wrappers
 *               where `comm=` would return the interpreter name.
 *  - `etimes=` — process age in seconds; used to detect PID reuse against the
 *                recorded startedAt timestamp.
 */
async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  try {
    // Two separate ps calls so we can parse each field unambiguously
    // (args= can contain spaces; mixing with etimes= in one call risks misparse).
    const [argsResult, etimeResult] = await Promise.all([
      execFileAsync('ps', ['-p', String(pid), '-o', 'args='], { timeout: 3000 }),
      execFileAsync('ps', ['-p', String(pid), '-o', 'etimes='], { timeout: 3000 }),
    ]);
    const args = argsResult.stdout.trim();
    const etimeSeconds = parseInt(etimeResult.stdout.trim(), 10);
    if (!args || isNaN(etimeSeconds)) return null;
    return { args, etimeSeconds };
  } catch {
    return null;
  }
}

function extractPort(hostUrl: string): number | null {
  try {
    const p = parseInt(new URL(hostUrl).port, 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}
