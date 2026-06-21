/**
 * `horus telemetry` — the control surface for usage telemetry (HOR-323).
 *
 * Subcommands: status | enable | disable | enable-content | disable-content |
 * reset-id | delete. All state lives in `~/.horus/telemetry.json`; env overrides
 * (DO_NOT_TRACK / HORUS_TELEMETRY / CI) are surfaced by `status` so users can see
 * why the effective decision may differ from what they saved.
 */
import pc from 'picocolors';
import { randomUUID } from 'node:crypto';
import {
  readTelemetryState,
  updateTelemetryState,
  deleteTelemetryState,
} from '../lib/telemetry/store.js';
import { resolveConsent } from '../lib/telemetry/consent.js';
import { clearSpool } from '../lib/telemetry/spool.js';
import { telemetryPath } from '../lib/telemetry/paths.js';
import { PRIVACY_URL } from '../lib/telemetry/notice.js';

function onOff(enabled: boolean): string {
  return enabled ? pc.green('on') : pc.dim('off');
}

function warnIfEnvOverrides(): void {
  const decision = resolveConsent();
  if (decision.forcedOff) {
    console.log(
      pc.yellow(
        `\nNote: telemetry is currently forced off by your environment (${decision.reason}).`,
      ),
    );
    console.log(pc.dim('Your saved preference will apply once that override is removed.'));
  } else if (decision.source === 'ci') {
    console.log(
      pc.yellow('\nNote: CI environment detected — telemetry stays off here regardless.'),
    );
  }
}

export async function runTelemetryStatus(): Promise<number> {
  const state = readTelemetryState();
  const decision = resolveConsent({ state });

  console.log(pc.bold('Horus telemetry'));
  console.log(
    `  Usage metadata (Tier A): ${onOff(decision.tierA)}  ${pc.dim(`[${decision.source}]`)}`,
  );
  console.log(`  Content sharing (Tier B): ${onOff(decision.tierB)}`);
  console.log(pc.dim(`  Reason: ${decision.reason}`));
  if (state) {
    console.log(pc.dim(`  Install ID: ${state.installId}`));
    console.log(
      pc.dim(
        `  Saved: Tier A ${state.tierA.enabled ? 'on' : 'off'}, Tier B ${
          state.tierB.enabled ? 'on' : 'off'
        }`,
      ),
    );
  } else {
    console.log(pc.dim('  No saved preference yet (defaults apply).'));
  }
  console.log(pc.dim(`  Config: ${telemetryPath()}`));
  console.log(pc.dim(`  Privacy: ${PRIVACY_URL}`));

  if (!state || decision.source === 'env' || decision.source === 'ci') {
    warnIfEnvOverrides();
  }
  return 0;
}

export async function runTelemetryEnable(): Promise<number> {
  updateTelemetryState((s) => {
    s.tierA.enabled = true;
    if (!s.tierA.noticeShownAt) s.tierA.noticeShownAt = new Date().toISOString();
  });
  console.log(pc.green('Anonymous usage metadata (Tier A) is now ON. Thank you!'));
  warnIfEnvOverrides();
  return 0;
}

export async function runTelemetryDisable(): Promise<number> {
  updateTelemetryState((s) => {
    s.tierA.enabled = false;
    // Disabling metadata also disables the content tier (it's a superset).
    s.tierB.enabled = false;
    if (!s.tierA.noticeShownAt) s.tierA.noticeShownAt = new Date().toISOString();
  });
  console.log(pc.yellow('All telemetry is now OFF (Tier A and Tier B).'));
  return 0;
}

export async function runTelemetryEnableContent(): Promise<number> {
  updateTelemetryState((s) => {
    s.tierA.enabled = true; // content requires metadata
    s.tierB.enabled = true;
    s.tierB.enabledAt = new Date().toISOString();
    if (!s.tierA.noticeShownAt) s.tierA.noticeShownAt = new Date().toISOString();
  });
  console.log(
    pc.green('Content sharing (Tier B) is now ON — redacted inputs/outputs help improve Horus.'),
  );
  console.log(pc.dim('Content is scrubbed of secrets/PII before it ever leaves your machine.'));
  console.log(pc.dim(`What this means: ${PRIVACY_URL}`));
  warnIfEnvOverrides();
  return 0;
}

export async function runTelemetryDisableContent(): Promise<number> {
  updateTelemetryState((s) => {
    s.tierB.enabled = false;
  });
  console.log(pc.yellow('Content sharing (Tier B) is now OFF. Usage metadata is unchanged.'));
  return 0;
}

export async function runTelemetryResetId(): Promise<number> {
  const next = randomUUID();
  updateTelemetryState((s) => {
    s.installId = next;
  });
  console.log(pc.green('Install ID reset.'));
  console.log(pc.dim(`  New install ID: ${next}`));
  return 0;
}

export async function runTelemetryDelete(): Promise<number> {
  deleteTelemetryState();
  clearSpool();
  console.log(pc.green('Local telemetry state deleted (install ID + saved preferences).'));
  console.log(
    pc.dim(
      'Next run will treat this as a fresh install and re-show the notice. Server-side deletion of already-uploaded data lands with the cloud sink (HOR-327).',
    ),
  );
  return 0;
}
