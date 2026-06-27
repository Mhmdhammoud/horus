/**
 * HOR-364 — orphaned source-host reaper.
 *
 * `horus hosts` only knows about REGISTERED projects. A `horus-source host --port N` process
 * whose owning record is gone — repo unregistered, host crashed/restarted, or a DUPLICATE
 * bound near a port another host already claims — is invisible to it, yet still holds memory +
 * a Kùzu lock. Stacked up, these wedge the machine (observed: two hosts on 8420). This finds
 * such orphans by scanning for `horus-source host` processes whose pid isn't recorded by any
 * registered repo, and reaps them. Only processes whose argv unmistakably matches a Horus
 * source host are ever considered — we never signal an unrelated process.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunningHost {
  pid: number;
  port: number;
}

/** Matches a `horus-source host --port <N>` argv (optional path prefix), capturing the port. */
const HOST_ARGV = /(?:^|\s)(?:\S*\/)?horus-source\s+host\s+--port(?:=|\s+)(\d+)(?=\s|$)/;

/** Parse `ps -axww -o pid=,args=` output into the running source-host processes. Pure. */
export function parseSourceHosts(psStdout: string): RunningHost[] {
  const hosts: RunningHost[] = [];
  for (const line of psStdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    if (sp < 0) continue;
    const pid = Number(trimmed.slice(0, sp));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const m = HOST_ARGV.exec(trimmed.slice(sp + 1));
    if (!m) continue;
    hosts.push({ pid, port: Number(m[1]) });
  }
  return hosts;
}

/**
 * Pure: a running host whose pid is not claimed by any registered repo is an orphan.
 * Matching on pid (not port) catches a duplicate bound to a port another host already owns.
 */
export function selectOrphans(running: RunningHost[], claimedPids: Set<number>): RunningHost[] {
  return running.filter((h) => !claimedPids.has(h.pid));
}

/** Discover running source-host processes via `ps` (best-effort; [] on any error). */
export async function listRunningSourceHosts(): Promise<RunningHost[]> {
  try {
    const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,args='], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    return parseSourceHosts(stdout);
  } catch {
    return [];
  }
}

/** Is `pid` alive? Uses signal 0 (no-op probe). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it → treat as alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** SIGTERM then escalate to SIGKILL; resolves true once the pid is gone. */
export async function reapPid(
  pid: number,
  opts: { termMs?: number; killMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const termMs = opts.termMs ?? 4000;
  const killMs = opts.killMs ?? 3000;
  const pollMs = opts.pollMs ?? 200;
  for (const [signal, wait] of [
    ['SIGTERM', termMs],
    ['SIGKILL', killMs],
  ] as const) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true; // already gone
    }
    const deadline = Date.now() + wait;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      if (!isAlive(pid)) return true;
    }
  }
  return !isAlive(pid);
}
