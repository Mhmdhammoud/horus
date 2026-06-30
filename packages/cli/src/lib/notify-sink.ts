/**
 * Outbound notify sink for `horus watch` (HOR-454).
 *
 * When a watched auto-investigation clears the configured confidence threshold, its one-line
 * headline is dispatched here — to a generic HMAC-signed webhook and/or a Horus Cloud push.
 *
 * This is a CLI/notify-layer concern ONLY. The deterministic investigation engine never sees it;
 * it consumes a finished report. Dispatch is BEST-EFFORT and never throws: a failed send is
 * returned as a typed failure so the watch loop can log it and carry on (the watcher's whole
 * contract is "never crash"). No daemon — `watch` stays a poller; inbound push lives cloud-side.
 */
import { createHmac } from 'node:crypto';
import type { NotifyConfig } from '@horus/core';
import type { InvestigationReport } from '@horus/engine';

/** A finished headline ready to dispatch (the shape `headlineFor` already produces + the id). */
export interface NotifyHeadline {
  investigationId: string;
  hint: string;
  cause: string;
  confidence: number;
}

/** Outcome of one sink dispatch — never thrown, always returned, so the loop logs and continues. */
export interface NotifyResult {
  target: 'webhook' | 'cloud';
  ok: boolean;
  detail: string;
}

/** Build the JSON payload posted to a webhook (Slack-compatible `text` + structured fields). */
export function buildWebhookPayload(h: NotifyHeadline): Record<string, unknown> {
  const pct = `${Math.round(h.confidence * 100)}%`;
  return {
    text: `🔭 Horus: ${h.hint} → ${h.cause} (${pct})`,
    investigationId: h.investigationId,
    hint: h.hint,
    cause: h.cause,
    confidence: h.confidence,
  };
}

/** Hex HMAC-SHA256 of the exact body string under `secret` — the `X-Horus-Signature` value. */
export function signPayload(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Should this report be dispatched? True when confidence clears the sink's threshold. */
export function shouldNotify(confidence: number, notify: NotifyConfig | undefined): boolean {
  if (notify === undefined) return false;
  if (notify.webhook === undefined && notify.cloud !== true) return false;
  return confidence >= notify.minConfidence;
}

async function postWebhook(
  url: string,
  secret: string | undefined,
  h: NotifyHeadline,
  timeoutMs: number,
): Promise<NotifyResult> {
  const body = JSON.stringify(buildWebhookPayload(h));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== undefined) headers['x-horus-signature'] = signPayload(body, secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) return { target: 'webhook', ok: false, detail: `HTTP ${res.status}` };
    return { target: 'webhook', ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { target: 'webhook', ok: false, detail: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a finished headline to all configured sinks. BEST-EFFORT: returns one NotifyResult per
 * attempted target (empty when nothing is configured or confidence is below threshold). Never throws.
 * The optional `cloudPush` is injected by the caller (the watcher already holds a cloud session), so
 * this module stays free of cloud-client wiring and is unit-testable in isolation.
 */
export async function dispatchNotify(
  report: Pick<InvestigationReport, 'id' | 'confidence'> & { hint: string; cause: string },
  notify: NotifyConfig | undefined,
  opts: { timeoutMs?: number; cloudPush?: () => Promise<void> } = {},
): Promise<NotifyResult[]> {
  if (notify === undefined) return [];
  const h: NotifyHeadline = {
    investigationId: report.id,
    hint: report.hint,
    cause: report.cause,
    confidence: report.confidence,
  };
  if (!shouldNotify(report.confidence, notify)) return [];
  const timeoutMs = opts.timeoutMs ?? 5000;
  const results: NotifyResult[] = [];
  if (notify.webhook !== undefined) {
    results.push(await postWebhook(notify.webhook.url, notify.webhook.secret, h, timeoutMs));
  }
  if (notify.cloud === true && opts.cloudPush !== undefined) {
    try {
      await opts.cloudPush();
      results.push({ target: 'cloud', ok: true, detail: 'pushed' });
    } catch (err) {
      results.push({ target: 'cloud', ok: false, detail: (err as Error).message });
    }
  }
  return results;
}
