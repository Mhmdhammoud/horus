import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  spoolEvent,
  readSpooledEvents,
  clearSpool,
  MAX_SPOOL_BYTES,
  SPOOL_FILE,
} from './spool.js';
import { telemetryQueueDir } from './paths.js';
import type { TelemetryEvent } from './events.js';

let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HORUS_HOME;
  home = mkdtempSync(join(tmpdir(), 'horus-spool-'));
  process.env.HORUS_HOME = home;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HORUS_HOME;
  else process.env.HORUS_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function ev(i: number): TelemetryEvent {
  return {
    schemaVersion: 1,
    tier: 'A',
    ts: '2026-06-22T00:00:00.000Z',
    installId: 'id',
    sessionId: 's',
    cliVersion: '0',
    os: 'x',
    arch: 'y',
    type: 'command.invoked',
    command: `c${i}`,
    flags: [],
  };
}

function spoolSize(): number {
  return statSync(join(telemetryQueueDir(), SPOOL_FILE)).size;
}

describe('telemetry spool', () => {
  it('appends and reads back events as JSON lines', () => {
    spoolEvent(ev(1));
    spoolEvent(ev(2));
    const got = readSpooledEvents();
    expect(got).toHaveLength(2);
    expect(got.map((e) => e.type)).toEqual(['command.invoked', 'command.invoked']);
    expect((got[0] as { command: string }).command).toBe('c1');
  });

  it('returns empty when no spool exists', () => {
    expect(readSpooledEvents()).toEqual([]);
  });

  it('clearSpool empties the spool', () => {
    spoolEvent(ev(1));
    clearSpool();
    expect(readSpooledEvents()).toEqual([]);
  });

  it('is bounded by MAX_SPOOL_BYTES and stops growing once full', () => {
    let i = 0;
    while (i < 10000) {
      spoolEvent(ev(i++));
      if (spoolSize() >= MAX_SPOOL_BYTES) break;
    }
    const sizeWhenFull = spoolSize();
    for (let k = 0; k < 200; k++) spoolEvent(ev(k));
    expect(spoolSize()).toBe(sizeWhenFull); // further appends are dropped
  });
});
