import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { track } from './client.js';
import { readSpooledEvents } from './spool.js';
import { loadOrInitTelemetryState, updateTelemetryState } from './store.js';

const ENV_KEYS = [
  'HORUS_HOME',
  'DO_NOT_TRACK',
  'HORUS_TELEMETRY',
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

let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'horus-client-'));
  process.env.HORUS_HOME = home;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('track', () => {
  it('spools a Tier-A event with base context when enabled', () => {
    loadOrInitTelemetryState(); // Tier A default-on + installId
    track({ type: 'command.invoked', command: 'investigate', flags: ['service', 'json'] });

    const events = readSpooledEvents();
    expect(events).toHaveLength(1);
    const e = events[0] as unknown as Record<string, unknown>;
    expect(e.type).toBe('command.invoked');
    expect(e.command).toBe('investigate');
    expect(e.tier).toBe('A');
    expect(e.installId).toBeTruthy();
    expect(e.sessionId).toBeTruthy();
    expect(e.cliVersion).toBeTruthy();
    expect(e.flags).toEqual(['service', 'json']);
  });

  it('does not spool when Tier A is disabled', () => {
    updateTelemetryState((s) => {
      s.tierA.enabled = false;
    });
    track({ type: 'command.invoked', command: 'status', flags: [] });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('does not spool under DO_NOT_TRACK', () => {
    loadOrInitTelemetryState();
    process.env.DO_NOT_TRACK = '1';
    track({ type: 'command.invoked', command: 'status', flags: [] });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('does not spool when no install identity exists yet', () => {
    // No loadOrInit: state is null, so there is no installId to attribute to.
    track({ type: 'command.invoked', command: 'status', flags: [] });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('does not spool a Tier-B content event when only Tier A is enabled', () => {
    loadOrInitTelemetryState(); // Tier A on, Tier B off (default)
    track({
      type: 'investigation.content',
      investigationId: 'inv-1',
      hint: 'redacted hint',
      summary: 'redacted summary',
      findingTitles: [],
      suspectedCauseTitles: [],
      confidence: 0.5,
    });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('spools a Tier-B content event (tier "B") when content sharing is enabled', () => {
    updateTelemetryState((s) => {
      s.tierA.enabled = true;
      s.tierB.enabled = true;
    });
    track({
      type: 'investigation.content',
      investigationId: 'inv-1',
      hint: 'redacted hint',
      summary: 'redacted summary',
      findingTitles: ['f1'],
      suspectedCauseTitles: ['c1'],
      confidence: 0.5,
    });
    const events = readSpooledEvents();
    expect(events).toHaveLength(1);
    const e = events[0] as unknown as Record<string, unknown>;
    expect(e.type).toBe('investigation.content');
    expect(e.tier).toBe('B');
    expect(e.investigationId).toBe('inv-1');
  });

  it('never throws', () => {
    expect(() => track({ type: 'command.invoked', command: 'x', flags: [] })).not.toThrow();
  });
});
