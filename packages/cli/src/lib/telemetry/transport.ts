/**
 * Telemetry transport (HOR-324, Phase 1b): drain the local spool to the cloud
 * ingest endpoint. Best-effort and time-boxed — a slow or offline endpoint must
 * never delay a command meaningfully or surface an error. On a fully successful
 * flush the spool is cleared; on any failure it is left intact for the next run
 * (the ingest endpoint tolerates duplicates, so re-sending is safe).
 *
 * Anonymous by design: events carry only a random installId, so this posts to
 * the public `POST /v1/telemetry` with no auth. Base URL precedence lets tests
 * and self-hosting point it elsewhere.
 */
import { readSpooledEvents, clearSpool } from './spool.js';
import { resolveConsent } from './consent.js';
import { readAuth } from '../cloud/auth-store.js';
import { DEFAULT_API_BASE_URL } from '../cloud/api.js';

const CHUNK = 100;
const DEFAULT_TIMEOUT_MS = 1500;

/** Where to send telemetry: explicit override → logged-in base → default. */
export function telemetryBaseUrl(): string {
  return (
    process.env.HORUS_TELEMETRY_URL ??
    process.env.HORUS_API_BASE_URL ??
    readAuth()?.apiBaseUrl ??
    DEFAULT_API_BASE_URL
  );
}

async function postBatch(url: string, events: unknown[], signal: AbortSignal): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
    signal,
  });
  return res.ok;
}

/**
 * Flush spooled Tier-A events. No-ops when telemetry is disabled or the spool is
 * empty. Never throws.
 */
export async function flushTelemetry(opts: { timeoutMs?: number } = {}): Promise<void> {
  try {
    if (!resolveConsent().tierA) return;
    const events = readSpooledEvents();
    if (events.length === 0) return;

    const url = `${telemetryBaseUrl().replace(/\/$/, '')}/v1/telemetry`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      for (let i = 0; i < events.length; i += CHUNK) {
        const ok = await postBatch(url, events.slice(i, i + CHUNK), controller.signal);
        if (!ok) return; // server rejected — keep the spool, retry next run
      }
      clearSpool(); // only once every batch was accepted
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* offline / timeout / error — keep the spool for the next run */
  }
}

/**
 * Best-effort server-side deletion of all events for an install (HOR-327).
 * Runs regardless of consent — a deletion request is always honored. Never
 * throws; if offline, local state is still cleared and the purge can be retried.
 */
export async function deleteRemoteTelemetry(
  installId: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    if (!installId) return;
    const url = `${telemetryBaseUrl().replace(/\/$/, '')}/v1/telemetry/delete`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* offline / error — local deletion still happened; server purge is retryable */
  }
}
