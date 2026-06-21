/**
 * Telemetry client (HOR-324): the one entry point command code calls to record a
 * Tier-A usage event. `track()` is fire-and-forget — it resolves consent, stamps
 * the base context, and spools the event. It NEVER throws, blocks, or awaits, so
 * it is safe to call from anywhere in a command's hot path.
 *
 * Transport (draining the spool to the cloud / anonymous ingest endpoint) is
 * Phase 1b and deliberately not wired here yet — events only spool locally.
 */
import { randomUUID } from 'node:crypto';
import { platform, arch as osArch } from 'node:os';
import { HORUS_VERSION } from '@horus/core';
import { resolveConsent } from './consent.js';
import { readTelemetryState } from './store.js';
import { spoolEvent } from './spool.js';
import {
  TELEMETRY_EVENT_SCHEMA_VERSION,
  type TelemetryEvent,
  type TelemetryEventInput,
} from './events.js';

// One id per process, lazily created, so events from a single CLI invocation can
// be correlated without persisting anything.
let sessionId: string | null = null;
function getSessionId(): string {
  if (!sessionId) sessionId = randomUUID();
  return sessionId;
}

/**
 * Record a Tier-A usage event. No-ops silently when telemetry is disabled, when
 * no install identity exists yet, or on any error.
 */
export function track(input: TelemetryEventInput): void {
  try {
    const state = readTelemetryState();
    // Gate on the resolved decision (honors DO_NOT_TRACK / HORUS_TELEMETRY / CI).
    if (!resolveConsent({ state }).tierA) return;
    if (!state) return; // identity is bootstrapped by the first-run notice

    const event = {
      schemaVersion: TELEMETRY_EVENT_SCHEMA_VERSION,
      tier: 'A' as const,
      ts: new Date().toISOString(),
      installId: state.installId,
      sessionId: getSessionId(),
      cliVersion: HORUS_VERSION,
      os: platform(),
      arch: osArch(),
      ...input,
    } as TelemetryEvent;

    spoolEvent(event);
  } catch {
    /* telemetry must never throw */
  }
}
