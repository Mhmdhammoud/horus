import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeShowFirstRunNotice } from './notice.js';
import { readTelemetryState } from './store.js';
import { telemetryPath } from './paths.js';

// The notice runs before EVERY command parse, so its safety invariants matter
// most: never throw, never print on non-TTY, never collect under opt-out.

const CI_KEYS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
];
const ENV_KEYS = ['HORUS_HOME', 'DO_NOT_TRACK', 'HORUS_TELEMETRY', ...CI_KEYS];

let home: string;
const saved: Record<string, string | undefined> = {};
let origIsTTY: unknown;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stderr, 'isTTY', { value, configurable: true });
}

function spyWrite() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'horus-notice-'));
  process.env.HORUS_HOME = home;
  origIsTTY = (process.stderr as unknown as { isTTY: unknown }).isTTY;
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stderr, 'isTTY', { value: origIsTTY, configurable: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('maybeShowFirstRunNotice', () => {
  it('prints the banner once on an interactive run, then never again', () => {
    setTTY(true);
    const w = spyWrite();
    maybeShowFirstRunNotice(['node', 'horus', 'investigate', 'x']);
    expect(w).toHaveBeenCalledTimes(1);
    expect(readTelemetryState()?.tierA.noticeShownAt).toBeTruthy();

    w.mockClear();
    maybeShowFirstRunNotice(['node', 'horus', 'investigate', 'y']);
    expect(w).not.toHaveBeenCalled();
  });

  it('does not print on a non-TTY run, but still bootstraps the install identity', () => {
    setTTY(false);
    const w = spyWrite();
    maybeShowFirstRunNotice(['node', 'horus', 'investigate', 'x']);
    expect(w).not.toHaveBeenCalled();
    const state = readTelemetryState();
    expect(state?.installId).toBeTruthy();
    // Deferred — banner should show on the next interactive run.
    expect(state?.tierA.noticeShownAt).toBeNull();
  });

  it('creates no file and prints nothing when DO_NOT_TRACK is set', () => {
    setTTY(true);
    process.env.DO_NOT_TRACK = '1';
    const w = spyWrite();
    maybeShowFirstRunNotice(['node', 'horus', 'investigate', 'x']);
    expect(w).not.toHaveBeenCalled();
    expect(existsSync(telemetryPath())).toBe(false);
  });

  it('creates no file and prints nothing in CI', () => {
    setTTY(true);
    process.env.CI = 'true';
    const w = spyWrite();
    maybeShowFirstRunNotice(['node', 'horus', 'investigate', 'x']);
    expect(w).not.toHaveBeenCalled();
    expect(existsSync(telemetryPath())).toBe(false);
  });

  it('suppresses the banner for meta commands but still bootstraps identity', () => {
    setTTY(true);
    const w = spyWrite();
    maybeShowFirstRunNotice(['node', 'horus', 'telemetry', 'status']);
    expect(w).not.toHaveBeenCalled();
    expect(readTelemetryState()?.tierA.noticeShownAt).toBeNull();
  });

  it('never throws, even on empty argv', () => {
    setTTY(true);
    expect(() => maybeShowFirstRunNotice([])).not.toThrow();
  });
});
