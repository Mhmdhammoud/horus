import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseResolved,
  parseManualEstimate,
  submitFeedback,
  maybePromptFeedback,
} from './feedback.js';
import { readSpooledEvents } from './spool.js';
import { loadOrInitTelemetryState, updateTelemetryState } from './store.js';
import { runFeedback } from '../../commands/feedback.js';

const ENV_KEYS = [
  'HORUS_HOME',
  'DO_NOT_TRACK',
  'HORUS_TELEMETRY',
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
];

let home: string;
const saved: Record<string, string | undefined> = {};
let origIn: unknown;
let origOut: unknown;

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'horus-fb-'));
  process.env.HORUS_HOME = home;
  origIn = (process.stdin as unknown as { isTTY: unknown }).isTTY;
  origOut = (process.stdout as unknown as { isTTY: unknown }).isTTY;
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process.stdin, 'isTTY', { value: origIn, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: origOut, configurable: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('feedback parsing', () => {
  it('parseResolved maps coarse answers', () => {
    expect(parseResolved('y')).toBe('yes');
    expect(parseResolved('Partly')).toBe('partly');
    expect(parseResolved('no')).toBe('no');
    expect(parseResolved('')).toBeNull();
    expect(parseResolved('huh')).toBeNull();
  });

  it('parseManualEstimate maps buckets to minutes', () => {
    expect(parseManualEstimate('1')).toBe(5);
    expect(parseManualEstimate('3')).toBe(120);
    expect(parseManualEstimate('5')).toBeNull(); // unsure
    expect(parseManualEstimate('x')).toBeNull();
  });
});

describe('submitFeedback', () => {
  it('emits a Tier-A feedback event', () => {
    loadOrInitTelemetryState();
    submitFeedback({
      investigationId: 'inv-1',
      resolved: 'yes',
      manualEstimateMinutes: 120,
      horusSeconds: 8,
      source: 'prompt',
    });
    const events = readSpooledEvents();
    expect(events).toHaveLength(1);
    const e = events[0] as unknown as Record<string, unknown>;
    expect(e.type).toBe('feedback.submitted');
    expect(e.tier).toBe('A');
    expect(e.resolved).toBe('yes');
    expect(e.manualEstimateMinutes).toBe(120);
    expect(e.source).toBe('prompt');
  });
});

describe('runFeedback (non-interactive flag path — agent/scripted)', () => {
  it('emits a feedback event from --resolved without a TTY, tagged source=flag', async () => {
    loadOrInitTelemetryState();
    setTTY(false); // agents run non-interactively
    const code = await runFeedback('inv-9', { resolved: 'partly', manualEstimateMin: '30' });
    expect(code).toBe(0);
    const events = readSpooledEvents();
    expect(events).toHaveLength(1);
    const e = events[0] as unknown as Record<string, unknown>;
    expect(e.type).toBe('feedback.submitted');
    expect(e.resolved).toBe('partly');
    expect(e.manualEstimateMinutes).toBe(30);
    expect(e.source).toBe('flag');
  });

  it('rejects an invalid --resolved verdict and emits nothing', async () => {
    loadOrInitTelemetryState();
    setTTY(false);
    const code = await runFeedback('inv-9', { resolved: 'maybe' });
    expect(code).toBe(1);
    expect(readSpooledEvents()).toEqual([]);
  });

  it('requires a TTY when no --resolved flag is given', async () => {
    loadOrInitTelemetryState();
    setTTY(false);
    const code = await runFeedback('inv-9', {});
    expect(code).toBe(1);
    expect(readSpooledEvents()).toEqual([]);
  });
});

describe('maybePromptFeedback gating (never reaches the prompt)', () => {
  it('skips on non-TTY', async () => {
    loadOrInitTelemetryState();
    setTTY(false);
    await maybePromptFeedback({ investigationId: 'inv-1', random: () => 0 });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('skips outside the sample (random > rate)', async () => {
    loadOrInitTelemetryState();
    setTTY(true);
    await maybePromptFeedback({ investigationId: 'inv-1', sampleRate: 0.25, random: () => 0.9 });
    expect(readSpooledEvents()).toEqual([]);
  });

  it('skips when telemetry is disabled', async () => {
    updateTelemetryState((s) => {
      s.tierA.enabled = false;
    });
    setTTY(true);
    await maybePromptFeedback({ investigationId: 'inv-1', sampleRate: 1, random: () => 0 });
    expect(readSpooledEvents()).toEqual([]);
  });
});
