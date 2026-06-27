/**
 * Unit tests for the version-pin guard that keeps a drifted `horus-source` backend from
 * analyzing or hosting a repo. A mismatch re-corrupts the Kùzu graph identically on every
 * rebuild, so we must refuse to launch it rather than fail silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PINNED_SOURCE_VERSION } from '@horus/core';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

import * as childProcess from 'node:child_process';
import {
  assertSourceVersionPinned,
  SourceVersionMismatchError,
  getSourceVersion,
  reconcileSpawnedHostPid,
  readSpawnedHost,
  analyzeRepo,
} from './lifecycle.js';

describe('analyzeRepo — surfaces the real failure (HOR-381)', () => {
  // resolveSourceBin runs `--version` (succeeds → bin found); the `analyze` call fails.
  function stubAnalyzeFailure(makeErr: () => Error): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockExecFile as any).mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: ExecFileCb) => {
        if (Array.isArray(args) && (args as string[]).includes('analyze')) {
          cb(makeErr(), undefined);
        } else {
          cb(null, { stdout: 'horus-source 1.5.4', stderr: '' });
        }
      },
    );
  }

  it('reports a timeout instead of a bare command-failed', async () => {
    stubAnalyzeFailure(() => {
      const e = new Error('Command failed: horus-source analyze .') as Error & Record<string, unknown>;
      e.killed = true;
      e.signal = 'SIGTERM';
      e.stderr = 'embedding 10000 symbols…';
      return e;
    });
    await expect(analyzeRepo('/repo')).rejects.toThrow(/timed out after 900s/);
  });

  it('surfaces horus-source stderr on a non-timeout failure', async () => {
    stubAnalyzeFailure(() => {
      const e = new Error('Command failed') as Error & Record<string, unknown>;
      e.stderr = 'ModuleNotFoundError: no module named tree_sitter';
      return e;
    });
    await expect(analyzeRepo('/repo')).rejects.toThrow(/ModuleNotFoundError: no module named tree_sitter/);
  });
});

const mockExecFile = vi.mocked(childProcess.execFile);

type ExecFileCb = (err: Error | null, result?: { stdout: string; stderr: string }) => void;

/** Stub `horus-source --version` to print `stdout`, or fail (binary not found) when null. */
function stubVersion(stdout: string | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mockExecFile as any).mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: ExecFileCb) => {
      if (stdout === null) cb(new Error('command not found'), undefined);
      else cb(null, { stdout, stderr: '' });
    },
  );
}

beforeEach(() => vi.clearAllMocks());

// A semver guaranteed to differ from whatever the pin currently is (and to survive the
// \d+.\d+.\d+ parse in getSourceVersion), so this suite stays correct across pin bumps.
const DRIFTED = '99.99.99';

describe('getSourceVersion', () => {
  it('parses the semver out of the --version output', async () => {
    stubVersion('horus-source 1.4.0\n');
    expect(await getSourceVersion()).toBe('1.4.0');
  });

  it('returns null when the binary is not on PATH', async () => {
    stubVersion(null);
    expect(await getSourceVersion()).toBeNull();
  });
});

describe('assertSourceVersionPinned', () => {
  it('throws SourceVersionMismatchError when the installed version drifts from the pin', async () => {
    stubVersion(`horus-source ${DRIFTED}\n`);
    await expect(assertSourceVersionPinned()).rejects.toBeInstanceOf(SourceVersionMismatchError);
    await expect(assertSourceVersionPinned()).rejects.toThrow(DRIFTED);
    await expect(assertSourceVersionPinned()).rejects.toThrow(PINNED_SOURCE_VERSION);
  });

  it('resolves when the installed version matches the pin', async () => {
    stubVersion(`horus-source ${PINNED_SOURCE_VERSION}\n`);
    await expect(assertSourceVersionPinned()).resolves.toBeUndefined();
  });

  it('allows an unreadable version through (treated as unknown, like `horus status`)', async () => {
    stubVersion(null);
    await expect(assertSourceVersionPinned()).resolves.toBeUndefined();
  });
});

describe('reconcileSpawnedHostPid', () => {
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'horus-recon-'));
    mkdirSync(join(root, '.horus', 'source'), { recursive: true });
    return root;
  }
  function writeSpawned(root: string, pid: number, port = 8420): void {
    writeFileSync(
      join(root, '.horus', 'spawned-host.json'),
      JSON.stringify({ pid, port, root, startedAt: new Date(Date.now() - 1000).toISOString() }),
    );
  }
  function writeHostJson(root: string, pid: number, port = 8420): void {
    writeFileSync(
      join(root, '.horus', 'source', 'host.json'),
      JSON.stringify({ pid, port, repo_path: root, host_url: `http://127.0.0.1:${port}` }),
    );
  }

  it('rewrites the ownership pid to the backend server pid (preserving port/root)', () => {
    const root = makeRoot();
    try {
      writeSpawned(root, 1111);
      writeHostJson(root, 2222);
      reconcileSpawnedHostPid(root, 8420);
      const rec = readSpawnedHost(root)!;
      expect(rec.pid).toBe(2222);
      expect(rec.port).toBe(8420);
      expect(rec.root).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not adopt a backend record for a different port', () => {
    const root = makeRoot();
    try {
      writeSpawned(root, 1111, 8420);
      writeHostJson(root, 2222, 9999); // stale: different port
      reconcileSpawnedHostPid(root, 8420);
      expect(readSpawnedHost(root)?.pid).toBe(1111); // unchanged
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when there is no ownership record to refine', () => {
    const root = makeRoot();
    try {
      writeHostJson(root, 2222);
      reconcileSpawnedHostPid(root, 8420); // must not throw, must not create a record
      expect(readSpawnedHost(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
