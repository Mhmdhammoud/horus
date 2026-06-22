/**
 * Offline event spool: `~/.horus/telemetry-queue/events.jsonl` (HOR-324).
 *
 * Events are appended as JSON lines, fire-and-forget. The spool is BOUNDED — once
 * it reaches MAX_SPOOL_BYTES we stop appending rather than grow without limit, so
 * a logged-out / offline user can never accumulate an unbounded file. A future
 * flush (Phase 1b, once the cloud ingest endpoint exists) drains and clears it.
 *
 * Nothing here ever throws: telemetry must never break a command.
 */
import {
  mkdirSync,
  appendFileSync,
  statSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { telemetryQueueDir } from './paths.js';
import type { TelemetryEvent } from './events.js';

export const SPOOL_FILE = 'events.jsonl';
export const MAX_SPOOL_BYTES = 256 * 1024;

function spoolFilePath(): string {
  return join(telemetryQueueDir(), SPOOL_FILE);
}

/** Append one event to the spool, honoring the size cap. Never throws. */
export function spoolEvent(event: TelemetryEvent): void {
  try {
    mkdirSync(telemetryQueueDir(), { recursive: true });
    const file = spoolFilePath();
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      /* file not created yet */
    }
    if (size >= MAX_SPOOL_BYTES) return; // bounded — drop rather than grow
    appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch {
    /* never throw */
  }
}

/** Read and parse all spooled events, skipping any corrupt lines. */
export function readSpooledEvents(): TelemetryEvent[] {
  try {
    const file = spoolFilePath();
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as TelemetryEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TelemetryEvent => e !== null);
  } catch {
    return [];
  }
}

/** Drop the spool file (called by a successful flush, or `telemetry delete`). */
export function clearSpool(): void {
  try {
    const file = spoolFilePath();
    if (existsSync(file)) rmSync(file);
  } catch {
    /* ignore */
  }
}
