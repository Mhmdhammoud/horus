import pc from 'picocolors';
import { runFeedbackPrompt } from '../lib/telemetry/feedback.js';

/**
 * `horus feedback <investigationId>` — leave impact feedback on a past
 * investigation without waiting for the sampled inline prompt (HOR-326).
 */
export async function runFeedback(investigationId?: string): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(pc.yellow('horus feedback needs an interactive terminal.'));
    return 1;
  }
  const id = investigationId?.trim();
  if (!id) {
    console.error(pc.red('Usage: horus feedback <investigationId>'));
    return 1;
  }
  await runFeedbackPrompt(id, null);
  return 0;
}
