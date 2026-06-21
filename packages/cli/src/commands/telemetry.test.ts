import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTelemetryEnable,
  runTelemetryDisable,
  runTelemetryEnableContent,
  runTelemetryDisableContent,
  runTelemetryResetId,
  runTelemetryDelete,
  runTelemetryStatus,
} from './telemetry.js';
import { readTelemetryState } from '../lib/telemetry/store.js';
import { telemetryPath } from '../lib/telemetry/paths.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HORUS_HOME;
  home = mkdtempSync(join(tmpdir(), 'horus-tcmd-'));
  process.env.HORUS_HOME = home;
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HORUS_HOME;
  else process.env.HORUS_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('horus telemetry command mutators', () => {
  it('enable-content turns on both tiers (content requires metadata)', async () => {
    expect(await runTelemetryEnableContent()).toBe(0);
    const s = readTelemetryState();
    expect(s?.tierA.enabled).toBe(true);
    expect(s?.tierB.enabled).toBe(true);
    expect(s?.tierB.enabledAt).toBeTruthy();
  });

  it('disable cascades to turn off content too', async () => {
    await runTelemetryEnableContent();
    expect(await runTelemetryDisable()).toBe(0);
    const s = readTelemetryState();
    expect(s?.tierA.enabled).toBe(false);
    expect(s?.tierB.enabled).toBe(false);
  });

  it('disable-content keeps metadata on', async () => {
    await runTelemetryEnableContent();
    await runTelemetryDisableContent();
    const s = readTelemetryState();
    expect(s?.tierA.enabled).toBe(true);
    expect(s?.tierB.enabled).toBe(false);
  });

  it('enable turns metadata back on after a disable', async () => {
    await runTelemetryDisable();
    await runTelemetryEnable();
    expect(readTelemetryState()?.tierA.enabled).toBe(true);
  });

  it('reset-id changes the install id but preserves preferences', async () => {
    await runTelemetryEnableContent();
    const before = readTelemetryState();
    await runTelemetryResetId();
    const after = readTelemetryState();
    expect(after?.installId).not.toBe(before?.installId);
    expect(after?.tierB.enabled).toBe(true);
  });

  it('delete removes local state', async () => {
    await runTelemetryEnable();
    expect(existsSync(telemetryPath())).toBe(true);
    expect(await runTelemetryDelete()).toBe(0);
    expect(existsSync(telemetryPath())).toBe(false);
  });

  it('status returns 0 on a fresh install', async () => {
    expect(await runTelemetryStatus()).toBe(0);
  });
});
