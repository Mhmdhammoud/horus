import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadOrInitTelemetryState,
  readTelemetryState,
  updateTelemetryState,
  deleteTelemetryState,
  defaultTelemetryState,
  TELEMETRY_SCHEMA_VERSION,
} from './store.js';
import { telemetryPath } from './paths.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HORUS_HOME;
  home = mkdtempSync(join(tmpdir(), 'horus-telemetry-'));
  process.env.HORUS_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HORUS_HOME;
  else process.env.HORUS_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

describe('telemetry store', () => {
  it('initializes a fresh state with safe defaults and a stable install id', () => {
    expect(readTelemetryState()).toBeNull();

    const state = loadOrInitTelemetryState();
    expect(existsSync(telemetryPath())).toBe(true);
    expect(state.installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(state.tierA.enabled).toBe(true); // metadata default on
    expect(state.tierB.enabled).toBe(false); // content default off
    expect(state.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);

    // Stable across reads — does not regenerate the id.
    expect(loadOrInitTelemetryState().installId).toBe(state.installId);
  });

  it('round-trips state through disk', () => {
    const written = loadOrInitTelemetryState();
    const read = readTelemetryState();
    expect(read).toEqual(written);
  });

  it('updates fields, persists, and bumps updatedAt', () => {
    const before = loadOrInitTelemetryState();
    const after = updateTelemetryState((s) => {
      s.tierB.enabled = true;
      s.tierB.enabledAt = '2026-06-22T00:00:00.000Z';
    });
    expect(after.tierB.enabled).toBe(true);
    expect(readTelemetryState()?.tierB.enabled).toBe(true);
    expect(new Date(after.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );
    // installId is untouched by unrelated updates.
    expect(after.installId).toBe(before.installId);
  });

  it('deletes local state', () => {
    loadOrInitTelemetryState();
    expect(existsSync(telemetryPath())).toBe(true);
    deleteTelemetryState();
    expect(existsSync(telemetryPath())).toBe(false);
    expect(readTelemetryState()).toBeNull();
  });

  it('treats a corrupt or id-less file as missing, then re-initializes', () => {
    loadOrInitTelemetryState();
    // Invalid JSON → read returns null rather than throwing.
    writeFileSync(telemetryPath(), '{not json');
    expect(readTelemetryState()).toBeNull();
    // Valid JSON but missing the required installId → also null.
    writeFileSync(telemetryPath(), JSON.stringify({ tierA: { enabled: true } }));
    expect(readTelemetryState()).toBeNull();
    // Recovery: a fresh state is created with a new id.
    const recovered = loadOrInitTelemetryState();
    expect(recovered.installId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('builds a default state with an explicit install id', () => {
    expect(defaultTelemetryState('fixed-id').installId).toBe('fixed-id');
  });
});
