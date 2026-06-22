import pc from 'picocolors';
import { runFeedbackPrompt, submitFeedback, parseResolved } from '../lib/telemetry/feedback.js';

/**
 * `horus feedback <investigationId>` — leave impact feedback on a past investigation.
 *
 * Two modes:
 *   • Non-interactive (`--resolved yes|partly|no`): emit feedback directly, no TTY
 *     required. This is the path the `horus skill` instructs an agent to call after
 *     it has acted on an investigation and knows whether Horus pointed at the cause
 *     — closing the loop where most usage (agent-driven, non-interactive) otherwise
 *     produces no impact signal.
 *   • Interactive (no flags, TTY): the sampled post-result prompt (HOR-326).
 */
export async function runFeedback(
  investigationId?: string,
  opts: { resolved?: string; manualEstimateMin?: string } = {},
): Promise<number> {
  const id = investigationId?.trim();
  if (!id) {
    console.error(pc.red('Usage: horus feedback <investigationId> [--resolved yes|partly|no]'));
    return 1;
  }

  // Non-interactive path — agent/scripted feedback via flags. Works without a TTY.
  if (opts.resolved !== undefined) {
    const resolved = parseResolved(opts.resolved);
    if (resolved === null) {
      console.error(pc.red(`Invalid --resolved "${opts.resolved}". Use: yes | partly | no.`));
      return 1;
    }
    let manualEstimateMinutes: number | null = null;
    if (opts.manualEstimateMin !== undefined) {
      const n = Number.parseInt(opts.manualEstimateMin, 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(pc.red(`Invalid --manual-estimate-min "${opts.manualEstimateMin}" (expect a non-negative integer).`));
        return 1;
      }
      manualEstimateMinutes = n;
    }
    submitFeedback({ investigationId: id, resolved, manualEstimateMinutes, horusSeconds: null, source: 'flag' });
    console.log(pc.dim(`Feedback recorded (${resolved}) — thanks, this helps improve Horus.`));
    return 0;
  }

  // Interactive path — requires a TTY.
  if (!process.stdin.isTTY) {
    console.error(
      pc.yellow(
        'horus feedback needs an interactive terminal — or pass --resolved yes|partly|no for non-interactive (agent) use.',
      ),
    );
    return 1;
  }
  await runFeedbackPrompt(id, null);
  return 0;
}
