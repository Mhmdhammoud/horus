/**
 * Tier-A usage event taxonomy (HOR-324, epic HOR-322).
 *
 * Tier A is ANONYMOUS METADATA only — no free text, no flag values, no file
 * contents ever appear here. Each event carries a small base context (install
 * id, session, CLI version, OS) plus a few structured, non-sensitive fields.
 *
 * The `TelemetryEventInput` type is what callers pass to `track()`: it's each
 * event minus the base context, which the client fills in.
 */

export const TELEMETRY_EVENT_SCHEMA_VERSION = 1;

export type TelemetryTier = 'A' | 'B';

/** Context the client attaches to every event. Note: `type` is NOT here. */
export interface BaseEvent {
  schemaVersion: number;
  tier: TelemetryTier;
  ts: string;
  installId: string;
  sessionId: string;
  cliVersion: string;
  os: string;
  arch: string;
}

export interface CommandInvokedEvent extends BaseEvent {
  type: 'command.invoked';
  /** Full command path, e.g. "investigate" or "cloud sync". */
  command: string;
  /** Long-flag NAMES only — never values. */
  flags: string[];
}

export interface CommandCompletedEvent extends BaseEvent {
  type: 'command.completed';
  command: string;
  flags: string[];
  durationMs: number;
  exitCode: number;
  ok: boolean;
}

export interface ErrorRaisedEvent extends BaseEvent {
  type: 'error.raised';
  command: string;
  /** Error constructor name only — never the message. */
  errorClass: string;
}

/** Shape signal for an investigation — counts and flags, never report bodies. */
export interface InvestigationCompletedEvent extends BaseEvent {
  type: 'investigation.completed';
  confidence: number | null;
  evidenceCount: number;
  findingCount: number;
  suspectedCauseCount: number;
  /** True when the engine ran without source intelligence (capped confidence). */
  degraded: boolean;
  /** Number of gaps the engine reported — a direct "where it ran out" signal. */
  gapCount: number;
  hasAi: boolean;
}

export type TelemetryEvent =
  | CommandInvokedEvent
  | CommandCompletedEvent
  | ErrorRaisedEvent
  | InvestigationCompletedEvent;

/** Distributive omit so the discriminated union is preserved. */
type WithoutBase<T> = T extends unknown ? Omit<T, keyof BaseEvent> : never;

/** What callers pass to `track()` — the event minus its base context. */
export type TelemetryEventInput = WithoutBase<TelemetryEvent>;

/**
 * Extract long-flag NAMES from argv, dropping any values. `--service payments`
 * and `--json` both contribute only the flag name; positionals and values are
 * ignored entirely. This is the privacy-critical boundary for command events.
 */
export function extractFlagNames(argv: string[]): string[] {
  const names = new Set<string>();
  for (const token of argv.slice(2)) {
    if (token.startsWith('--') && token.length > 2) {
      const name = token.slice(2).split('=')[0];
      if (name) names.add(name);
    }
  }
  return [...names];
}
