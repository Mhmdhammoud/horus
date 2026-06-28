/**
 * Impact feedback (HOR-326). Captures the ground-truth signal for "Horus saved
 * me X%": a quick, skippable, sampled prompt after an investigation, plus the
 * explicit `horus feedback` command. The event is Tier A (coarse buckets, no
 * free text), so it rides the normal usage-telemetry consent + pipeline.
 *
 * Interactive only on a TTY; never blocks scripted/agent/`--json` runs.
 */
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { track } from './client.js';
import { resolveConsent } from './consent.js';

export type Resolved = 'yes' | 'partly' | 'no' | null;

/** Map the manual-time bucket key to representative minutes (5 = unsure → null). */
const MANUAL_MINUTES: Record<string, number | null> = {
  '1': 5, // < 5 min
  '2': 30, // ~30 min
  '3': 120, // ~2 h
  '4': 480, // half-day+
  '5': null, // unsure
};

export function parseResolved(raw: string): Resolved {
  const v = raw.trim().toLowerCase();
  if (v.startsWith('y')) return 'yes';
  if (v.startsWith('p')) return 'partly';
  if (v.startsWith('n')) return 'no';
  return null;
}

export function parseManualEstimate(raw: string): number | null {
  return MANUAL_MINUTES[raw.trim()] ?? null;
}

/** Emit a feedback event (Tier A). Self-gates on consent inside track(). */
export function submitFeedback(input: {
  investigationId: string;
  resolved: Resolved;
  manualEstimateMinutes: number | null;
  horusSeconds: number | null;
  /**
   * Where the feedback came from: `prompt` = a human answered the interactive
   * post-result prompt; `flag` = supplied non-interactively via `horus feedback
   * --resolved …` (typically an agent driving Horus through the skill). Lets the
   * metrics weigh/separate agent-attested vs human-attested impact.
   */
  source: 'prompt' | 'flag';
}): void {
  track({ type: 'feedback.submitted', ...input });
}

/** The verdict a completed prompt yields — fed to both the telemetry emit and the eval store. */
export interface FeedbackAnswer {
  resolved: Resolved;
  manualEstimateMinutes: number | null;
}

/**
 * Run the interactive prompt and emit the telemetry event. Returns the parsed answer (so callers
 * can ALSO persist it to the eval store, HOR-390), or `null` if the user skipped.
 */
export async function runFeedbackPrompt(
  investigationId: string,
  horusSeconds: number | null,
): Promise<FeedbackAnswer | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(pc.dim('\nQuick feedback to improve Horus (press Enter to skip):'));
    const a1 = await rl.question(
      pc.bold('  Did this point you at the cause? ') + pc.dim('[y / partly / n] '),
    );
    if (a1.trim() === '') return null;
    const a2 = await rl.question(
      pc.bold('  Manually, finding this would have taken? ') +
        pc.dim('[1:<5m  2:~30m  3:~2h  4:half-day+  5:unsure] '),
    );
    const resolved = parseResolved(a1);
    const manualEstimateMinutes = parseManualEstimate(a2);
    submitFeedback({
      investigationId,
      resolved,
      manualEstimateMinutes,
      horusSeconds,
      source: 'prompt',
    });
    console.log(pc.dim('  Thanks — recorded.'));
    return { resolved, manualEstimateMinutes };
  } finally {
    rl.close();
  }
}

/**
 * Sampled, best-effort feedback prompt for the end of `investigate`. No-ops on
 * non-TTY, when telemetry is off, or outside the sample. Never throws.
 */
export async function maybePromptFeedback(opts: {
  investigationId: string;
  horusSeconds?: number | null;
  sampleRate?: number;
  random?: () => number;
}): Promise<void> {
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return;
    if (!resolveConsent().tierA) return;
    const rate = opts.sampleRate ?? 0.25;
    const rand = (opts.random ?? Math.random)();
    if (rand > rate) return;
    await runFeedbackPrompt(opts.investigationId, opts.horusSeconds ?? null);
  } catch {
    /* feedback must never break the command */
  }
}
