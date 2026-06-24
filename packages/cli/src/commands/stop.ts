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
import {
  readSourceHostUrl,
  isHostHealthy,
  readSpawnedHost,
  readSourceHostPid,
  type SpawnedHostRecord,
} from '@horus/connectors';

const execFileAsync = promisify(execFile);
const unlinkAsync = promisify(unlink);

export interface StopOpts {
  all?: boolean;
}

const SPAWNED_HOST_FILE = 'spawned-host.json';
/** Tolerated drift between recorded start time and measured elapsed time (seconds). */
const START_TIME_TOLERANCE_S = 60;
/** How long to wait after SIGTERM for the process to exit. */
const STOP_WAIT_MS = 5_000;
/** Poll interval when waiting for a process to exit. */
const STOP_POLL_MS = 200;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const port = extractPort(hostUrl);
  if (port === null) {
    console.error(pc.red(`Cannot determine port from host URL: ${hostUrl}`));
    return 1;
  }

  const healthy = await isHostHealthy(hostUrl);
  if (!healthy) {
    // A failing /api/health does NOT prove the process is gone. A host can crash mid-index
    // yet keep its port bound and hold the Kùzu single-writer lock — in which case the next
    // `horus index` can't acquire it and keeps re-using the broken host. So only declare
    // "already stopped" when we own no still-running process; otherwise fall through and
    // terminate the stuck host (its identity is still verified before we signal it).
    const owned = readSpawnedHost(root);
    const wrapperAlive = owned !== null && (await getProcessInfo(owned.pid)) !== null;
    if (!wrapperAlive) {
      // The spawn-wrapper pid Horus recorded is gone — but `horus-source host` detaches the
      // real server under a DIFFERENT pid (recorded by the backend in source/host.json) that
      // can outlive the wrapper and keep the port + Kùzu lock held. Stop that server before
      // concluding the host is down — otherwise `horus stop` reports success while the host
      // is still listening (the exact zombie that blocks the next `horus index`).
      const res = await stopBackendServerPid(root, port);
      if (res === 'failed') return 1;
      if (res !== 'stopped') console.log(pc.dim(`Host ${hostUrl} is already stopped.`));
      await cleanupSpawnedRecord(root);
      return 0;
    }
    console.log(
      pc.dim(
        `Host ${hostUrl} is unreachable but pid ${owned!.pid} is still running — ` +
          `terminating a stuck host.`,
      ),
    );
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
    // The wrapper pid exited between the health check and here (a race) — but the detached
    // backend server (source/host.json) may still be alive, so try it before reporting
    // success.
    const res = await stopBackendServerPid(root, port);
    if (res === 'failed') return 1;
    if (res !== 'stopped') {
      console.log(pc.dim(`Process pid ${spawned.pid} is no longer running — already stopped.`));
    }
    await cleanupSpawnedRecord(root);
    return 0;
  }

  if (!hostArgvRegex(port).test(info.args)) {
    console.error(
      pc.red(
        `Pid ${spawned.pid} args do not match "horus-source host --port ${port}". ` +
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

  let signaled = false;
  try {
    process.kill(spawned.pid, 'SIGTERM');
    signaled = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // Process exited between our getProcessInfo check and the kill call — success.
      console.log(pc.dim(`Process pid ${spawned.pid} exited before signal — already stopped.`));
    } else {
      console.error(pc.red(`Failed to signal pid ${spawned.pid}: ${(err as Error).message}`));
      return 1;
    }
  }

  // After SIGTERM, poll until the process exits (confirms the signal was honoured).
  if (signaled) {
    const deadline = Date.now() + STOP_WAIT_MS;
    let exited = false;
    while (Date.now() < deadline) {
      await sleep(STOP_POLL_MS);
      if ((await getProcessInfo(spawned.pid)) === null) {
        exited = true;
        break;
      }
    }
    if (!exited) {
      console.error(
        pc.red(
          `Host pid ${spawned.pid} did not exit within ${STOP_WAIT_MS / 1000}s after SIGTERM.`,
        ),
      );
      return 1;
    }
    console.log(
      `${pc.green('✓')} Stopped source-intelligence host ` +
        pc.dim(`(pid ${spawned.pid}, port ${port})`) +
        ` for ${root}`,
    );
  }

  // The wrapper we recorded is down — but the detached backend server can be a separate,
  // still-listening pid. Reap it too so the port + Kùzu lock are actually released.
  if (await stopBackendServerPid(root, port) === 'failed') return 1;

  await cleanupSpawnedRecord(root);
  return 0;
}

/**
 * Build the argv matcher for a horus-source host on `port`. Requirements:
 *  - optional path prefix (handles /home/user/.local/bin/horus-source, a Python entrypoint)
 *  - binary then `host` then `--port` in that ORDER (not independent substrings)
 *  - port followed by whitespace or EOL so 8420 does not match 84200
 *  - `port` is an integer, so it carries no regex metacharacters
 */
function hostArgvRegex(port: number): RegExp {
  return new RegExp(
    `(?:^|\\s)(?:\\S*/)?horus-source\\s+host\\s+--port(?:=|\\s+)${String(port)}(?=\\s|$)`,
  );
}

/** Remove the spawn-wrapper ownership record. Best-effort; a missing file is benign. */
async function cleanupSpawnedRecord(root: string): Promise<void> {
  try {
    await unlinkAsync(join(root, HORUS_DIR, SPAWNED_HOST_FILE));
  } catch {
    // Not fatal — missing record is benign on the next invocation.
  }
}

/**
 * Stop the detached backend host server recorded in `.horus/source/host.json` for this
 * repo+port, if one is still alive. This is the process that actually holds the TCP port
 * and the Kùzu single-writer lock, and it can outlive the spawn-wrapper pid Horus tracks.
 *
 * Ownership is proven before signalling: the pid's argv must match
 * `horus-source host --port <port>`, and the record's port/repo must match what we are
 * stopping. Returns 'stopped' (we signalled it and it exited), 'failed' (signalled but it
 * would not die, or the record's identity could not be trusted), or 'none' (nothing alive
 * and owned to stop).
 */
type BackendStopResult = 'stopped' | 'failed' | 'none';

async function stopBackendServerPid(root: string, port: number): Promise<BackendStopResult> {
  const rec = readSourceHostPid(root);
  if (!rec) return 'none';
  // Only act when the backend's own record agrees on port and repo — otherwise it is a
  // stale or unrelated record and we must not signal off it.
  if (Number.isFinite(rec.port) && rec.port !== port) return 'none';
  if (rec.repoPath && rec.repoPath !== root) return 'none';

  const info = await getProcessInfo(rec.pid);
  if (info === null) return 'none'; // already gone

  if (!hostArgvRegex(port).test(info.args)) {
    // The pid is alive but is NOT our host (pid reuse / mismatched record). Refuse to
    // signal an unverified process — treat as nothing we own to stop.
    console.error(
      pc.red(
        `Backend host pid ${rec.pid} args do not match "horus-source host --port ${port}". ` +
          `Not signalling — possible stale source/host.json or PID reuse.`,
      ),
    );
    return 'failed';
  }

  try {
    process.kill(rec.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return 'stopped';
    console.error(pc.red(`Failed to signal pid ${rec.pid}: ${(err as Error).message}`));
    return 'failed';
  }

  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(STOP_POLL_MS);
    if ((await getProcessInfo(rec.pid)) === null) {
      console.log(
        `${pc.green('✓')} Stopped source-intelligence host ` +
          pc.dim(`(pid ${rec.pid}, port ${port})`) +
          ` for ${root}`,
      );
      return 'stopped';
    }
  }
  console.error(
    pc.red(`Host pid ${rec.pid} did not exit within ${STOP_WAIT_MS / 1000}s after SIGTERM.`),
  );
  return 'failed';
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
    // Something to stop if the host is healthy OR we still hold a record for it — either
    // the spawn-wrapper record or the backend's own host.json (a crashed host fails the
    // health check but may be alive and holding the port; stopHost sorts out which). Skip
    // only when none of these is present.
    const healthy = await isHostHealthy(hostUrl);
    if (
      !healthy &&
      readSpawnedHost(entry.root) === null &&
      readSourceHostPid(entry.root) === null
    ) {
      continue;
    }
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
 * Returns null ONLY when the process does not exist (no argv) — liveness is determined by
 * `args` alone, never by elapsed time, so a still-running process is never mistaken for
 * dead just because its age could not be read.
 *
 *  - `args=`  — full argv joined by spaces; handles Python-backed CLI wrappers where
 *               `comm=` would return the interpreter name.
 *  - `etime=` — process age, used to detect PID reuse against the recorded startedAt.
 *               We use `etime` (formatted), NOT `etimes` (raw seconds): `etimes` is a
 *               Linux/procps keyword that ERRORS on macOS ("etimes: keyword not found"),
 *               which previously made every lookup fail and `horus stop` wrongly report a
 *               live host as "already stopped". `etime` is portable across macOS and Linux.
 */
async function getProcessInfo(pid: number): Promise<ProcessInfo | null> {
  let args: string;
  try {
    const argsResult = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='], {
      timeout: 3000,
    });
    args = argsResult.stdout.trim();
  } catch {
    return null; // `ps -p` exits non-zero when the pid does not exist
  }
  if (!args) return null;

  // Elapsed time is best-effort: the process is already proven alive by `args`. A parse
  // failure leaves etimeSeconds NaN, which callers treat as "can't verify age" (and abort
  // for safety) rather than "process gone".
  let etimeSeconds = Number.NaN;
  try {
    const etimeResult = await execFileAsync('ps', ['-p', String(pid), '-o', 'etime='], {
      timeout: 3000,
    });
    etimeSeconds = parseEtimeSeconds(etimeResult.stdout.trim());
  } catch {
    // leave NaN — process is still alive (args present)
  }
  return { args, etimeSeconds };
}

/** Parse a ps `etime` field (`[[dd-]hh:]mm:ss`) to seconds, or NaN if it does not match. */
function parseEtimeSeconds(etime: string): number {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return Number.NaN;
  const days = m[1] ? Number(m[1]) : 0;
  const hours = m[2] ? Number(m[2]) : 0;
  const minutes = Number(m[3]);
  const seconds = Number(m[4]);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function extractPort(hostUrl: string): number | null {
  try {
    const p = parseInt(new URL(hostUrl).port, 10);
    return isNaN(p) ? null : p;
  } catch {
    return null;
  }
}
