import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushTelemetry } from './transport.js';
import { spoolEvent, readSpooledEvents } from './spool.js';
import { loadOrInitTelemetryState, updateTelemetryState } from './store.js';
import type { TelemetryEvent } from './events.js';

const ENV_KEYS = [
  'HORUS_HOME',
  'HORUS_TELEMETRY_URL',
  'HORUS_API_BASE_URL',
  'DO_NOT_TRACK',
  'HORUS_TELEMETRY',
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
];

let home: string;
const saved: Record<string, string | undefined> = {};

function event(i: number): TelemetryEvent {
  return {
    schemaVersion: 1,
    tier: 'A',
    ts: '2026-06-22T00:00:00.000Z',
    installId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    cliVersion: '0.2.3',
    os: 'darwin',
    arch: 'arm64',
    type: 'command.completed',
    command: `cmd${i}`,
    flags: ['json'],
    durationMs: 10,
    exitCode: 0,
    ok: true,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = mkdtempSync(join(tmpdir(), 'horus-transport-'));
  process.env.HORUS_HOME = home;
  process.env.HORUS_TELEMETRY_URL = 'http://localhost:9999';
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  rmSync(home, { recursive: true, force: true });
});

describe('flushTelemetry', () => {
  it('posts spooled events to /v1/telemetry and clears the spool on success', async () => {
    loadOrInitTelemetryState();
    spoolEvent(event(1));
    spoolEvent(event(2));
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true } as Response);

    await flushTelemetry();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://localhost:9999/v1/telemetry');
    expect((init as RequestInit).method).toBe('POST');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].command).toBe('cmd1');
    // sent successfully → spool cleared
    expect(readSpooledEvents()).toEqual([]);
  });

  it('keeps the spool when the server rejects the batch', async () => {
    loadOrInitTelemetryState();
    spoolEvent(event(1));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);

    await flushTelemetry();

    expect(readSpooledEvents()).toHaveLength(1); // retry next run
  });

  it('keeps the spool and never throws when offline', async () => {
    loadOrInitTelemetryState();
    spoolEvent(event(1));
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(flushTelemetry()).resolves.toBeUndefined();
    expect(readSpooledEvents()).toHaveLength(1);
  });

  it('does nothing when telemetry is disabled', async () => {
    loadOrInitTelemetryState();
    spoolEvent(event(1));
    updateTelemetryState((s) => {
      s.tierA.enabled = false;
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await flushTelemetry();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readSpooledEvents()).toHaveLength(1); // left intact, not sent
  });

  it('does nothing when the spool is empty', async () => {
    loadOrInitTelemetryState();
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await flushTelemetry();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
