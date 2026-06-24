/**
 * HOR-179 — Unit tests for `horus stop` shutdown reliability.
 *
 * Tests the key edge cases:
 *  - Process already gone when identity-checked → success, not failure.
 *  - Process exits within timeout after SIGTERM → success.
 *  - Process does NOT exit within timeout → failure.
 *  - Already-stopped host (health check fails) → idempotent success.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SpawnedHostRecord } from '@horus/connectors';

// ── Module-level mocks (hoisted before imports) ───────────────────────────────

vi.mock('@horus/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@horus/core')>();
  return {
    ...actual,
    findRepoRoot: vi.fn().mockReturnValue('/repo/root'),
    readRegistry: vi.fn().mockReturnValue({ projects: {} }),
    HORUS_DIR: '.horus',
  };
});

vi.mock('@horus/connectors', () => ({
  readSourceHostUrl: vi.fn().mockReturnValue('http://127.0.0.1:8420'),
  isHostHealthy: vi.fn().mockResolvedValue(true),
  readSpawnedHost: vi.fn(),
  readSourceHostPid: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  unlink: vi.fn((_path, cb) => cb(null)),
}));

import * as connectors from '@horus/connectors';
import * as childProcess from 'node:child_process';
import { runStop } from './stop.js';

const mockIsHostHealthy = vi.mocked(connectors.isHostHealthy);
const mockReadSpawnedHost = vi.mocked(connectors.readSpawnedHost);
const mockReadSourceHostPid = vi.mocked(connectors.readSourceHostPid);
const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

function stubExecWith(stdoutByArgs: Record<string, string>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation(
    (_cmd: unknown, args: string[], _opts: unknown, cb: ExecFileCb) => {
      const key = args.join(' ');
      const match = Object.entries(stdoutByArgs).find(([k]) => key.includes(k));
      if (match) {
        cb(null, { stdout: match[1], stderr: '' });
      } else {
        cb(new Error('ps: no such process'), undefined);
      }
    },
  );
}

function stubExecNotFound() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: ExecFileCb) => {
      cb(new Error('ps: no such process'), undefined);
    },
  );
}

const VALID_RECORD: SpawnedHostRecord = {
  pid: 42000,
  port: 8420,
  root: '/repo/root',
  startedAt: new Date(Date.now() - 30_000).toISOString(), // 30s ago
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: advance timers + flush promises concurrently so sleep() calls inside
// runStop resolve without hanging the test.
async function drainTimers(steps = 30) {
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(300);
  }
}

describe('horus stop — process-already-gone treated as success', () => {
  it('returns 0 when the process is gone before identity check (race fix)', async () => {
    mockReadSpawnedHost.mockReturnValue(VALID_RECORD);
    // ps returns nothing (process already gone) — should NOT return 1
    stubExecNotFound();

    const promise = runStop({});
    await drainTimers();
    const code = await promise;
    expect(code).toBe(0);
  });
});

describe('horus stop — post-SIGTERM confirmation loop', () => {
  it('returns 0 when process exits within timeout after SIGTERM', async () => {
    mockReadSpawnedHost.mockReturnValue(VALID_RECORD);
    let callCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: ExecFileCb) => {
        callCount++;
        const key = (args as string[]).join(' ');
        if (key.includes('args=') || key.includes('etime=')) {
          if (callCount <= 4) {
            // First two calls (args + etime for identity check) — process found
            cb(null, {
              stdout: key.includes('etime=') ? '00:30' : `horus-source host --port 8420`,
              stderr: '',
            });
          } else {
            // Subsequent poll calls (after SIGTERM) — process gone
            cb(new Error('no such process'), undefined);
          }
        } else {
          cb(new Error('unknown'), undefined);
        }
      },
    );

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = runStop({});
    await drainTimers();
    const code = await promise;
    expect(code).toBe(0);
    expect(killSpy).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('returns 1 when process does not exit within STOP_WAIT_MS', async () => {
    mockReadSpawnedHost.mockReturnValue(VALID_RECORD);
    // Process always found (never exits)
    stubExecWith({
      'args=': `horus-source host --port 8420`,
      'etime=': '00:30',
    });

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = runStop({});
    // Advance past the full 5-second timeout (5000ms / 200ms poll = 25+ ticks)
    await drainTimers(40);
    const code = await promise;
    expect(code).toBe(1);

    killSpy.mockRestore();
  });
});

describe('horus stop — already-stopped host is idempotent', () => {
  it('returns 0 and does not error when host is already not running', async () => {
    mockIsHostHealthy.mockResolvedValue(false);
    mockReadSpawnedHost.mockReturnValue(null); // no owned process → genuinely stopped

    const code = await runStop({});
    expect(code).toBe(0);
  });
});

describe('horus stop — unreachable but still-alive host (zombie) is terminated', () => {
  it('signals an owned pid that is still running even though /api/health fails', async () => {
    // The host crashed mid-index: health check fails, but the process is alive and
    // holding the port/Kùzu lock. stop must NOT report "already stopped" — it must kill it.
    mockIsHostHealthy.mockResolvedValue(false);
    mockReadSpawnedHost.mockReturnValue(VALID_RECORD);

    // The process must survive two getProcessInfo calls — the unreachable-branch liveness
    // probe and the identity check — then disappear once SIGTERM has been sent.
    let argsCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: ExecFileCb) => {
        const key = args.join(' ');
        if (key.includes('etime=')) {
          cb(null, { stdout: '00:30', stderr: '' });
        } else if (key.includes('args=')) {
          argsCalls++;
          if (argsCalls <= 2) {
            cb(null, { stdout: 'horus-source host --port 8420', stderr: '' });
          } else {
            cb(new Error('no such process'), undefined); // exited after SIGTERM
          }
        } else {
          cb(new Error('unknown'), undefined);
        }
      },
    );

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = runStop({});
    await drainTimers();
    const code = await promise;
    expect(code).toBe(0);
    expect(killSpy).toHaveBeenCalledWith(VALID_RECORD.pid, 'SIGTERM');

    killSpy.mockRestore();
  });
});

describe('horus stop — detached backend server outliving the spawn wrapper', () => {
  it('terminates the source/host.json server pid when the recorded wrapper pid is dead', async () => {
    // Real-world zombie: Horus recorded the spawn-wrapper pid (61283), which has since died,
    // but `horus-source host` detached the actual server under a different pid (59176) that
    // is still listening and holding the Kùzu lock. stop must reap the backend pid.
    mockIsHostHealthy.mockResolvedValue(false);
    mockReadSpawnedHost.mockReturnValue({ ...VALID_RECORD, pid: 61283 });
    mockReadSourceHostPid.mockReturnValue({ pid: 59176, port: 8420, repoPath: '/repo/root' });

    let serverArgsCalls = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementation(
      (_cmd: unknown, args: string[], _opts: unknown, cb: ExecFileCb) => {
        const key = args.join(' ');
        if (key.includes('61283')) {
          cb(new Error('no such process'), undefined); // wrapper pid is dead
        } else if (key.includes('59176')) {
          if (key.includes('etime=')) {
            cb(null, { stdout: '02:00', stderr: '' });
          } else {
            serverArgsCalls++;
            if (serverArgsCalls <= 1) {
              cb(null, { stdout: 'horus-source host --port 8420', stderr: '' });
            } else {
              cb(new Error('no such process'), undefined); // exits after SIGTERM
            }
          }
        } else {
          cb(new Error('unknown'), undefined);
        }
      },
    );

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = runStop({});
    await drainTimers();
    const code = await promise;
    expect(code).toBe(0);
    expect(killSpy).toHaveBeenCalledWith(59176, 'SIGTERM');
    expect(killSpy).not.toHaveBeenCalledWith(61283, 'SIGTERM');

    killSpy.mockRestore();
  });
});

describe('horus stop --all — summary counts correctly', () => {
  it('counts a process-already-gone stop as success (not failure)', async () => {
    const { readRegistry } = await import('@horus/core');
    vi.mocked(readRegistry).mockReturnValue({
      projects: {
        'maison-safqa': { root: '/repo/root', name: 'maison-safqa', configPath: '/repo/root/.horus/config.yml' },
      },
    } as ReturnType<typeof readRegistry>);
    // readSourceHostUrl + isHostHealthy + readSpawnedHost already mocked at top level
    mockIsHostHealthy.mockResolvedValue(true);
    mockReadSpawnedHost.mockReturnValue(VALID_RECORD);
    stubExecNotFound(); // process already gone

    const promise = runStop({ all: true });
    await drainTimers();
    const code = await promise;
    // Should be 0 — process-already-gone is treated as success
    expect(code).toBe(0);
  });
});
