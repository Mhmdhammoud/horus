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
  tierForEventType,
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
 * Record a usage event. The event's type determines its consent tier (Tier B for
 * content-bearing types, Tier A otherwise) and the matching consent is enforced.
 * No-ops silently when that tier is disabled, when no install identity exists
 * yet, or on any error.
 */
export function track(input: TelemetryEventInput): void {
  try {
    const state = readTelemetryState();
    if (!state) return; // identity is bootstrapped by the first-run notice

    const tier = tierForEventType(input.type);
    // Gate on the resolved decision (honors DO_NOT_TRACK / HORUS_TELEMETRY / CI).
    const decision = resolveConsent({ state });
    if (tier === 'A' ? !decision.tierA : !decision.tierB) return;

    const event = {
      schemaVersion: TELEMETRY_EVENT_SCHEMA_VERSION,
      tier,
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
