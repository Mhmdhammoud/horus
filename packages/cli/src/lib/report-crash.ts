/**
 * HOR-439: the error-message surface of the discoverable bug/gap report path.
 *
 * The CLI's top-level entrypoint funnels every uncaught failure through here, so
 * a crashing command (the ticket's own example — "explain crashes on monorepos")
 * is one copy-paste away from an actionable GitHub issue. We print the original
 * error FIRST (the stack/message stays the primary signal) and then a dim nudge —
 * the same `horus report` affordance surfaced in the investigate footer and
 * `horus doctor`, kept deliberately separate from `horus feedback`.
 */
import pc from 'picocolors';

export function reportCrash(
  err: unknown,
  log: (...args: unknown[]) => void = console.error,
): void {
  log(err);
  log(pc.dim('\n  Looks like a Horus bug or a missing capability? Report it:  horus report'));
}
