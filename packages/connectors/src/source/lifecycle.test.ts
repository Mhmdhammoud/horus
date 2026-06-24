/**
 * Unit tests for the version-pin guard that keeps a drifted `horus-source` backend from
 * analyzing or hosting a repo. A mismatch re-corrupts the Kùzu graph identically on every
 * rebuild, so we must refuse to launch it rather than fail silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
} from './lifecycle.js';

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
