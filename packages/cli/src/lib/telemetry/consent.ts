/**
 * Consent resolution for usage telemetry (HOR-323, epic HOR-322).
 *
 * The single source of truth for "are we allowed to collect, and at what tier".
 * Precedence is most-restrictive-wins:
 *
 *   1. Env hard opt-out — `DO_NOT_TRACK` (cross-tool standard) or
 *      `HORUS_TELEMETRY=0|off|false` force everything off. No file is even read.
 *   2. CI — automation collects nothing by default unless `HORUS_TELEMETRY` is
 *      explicitly enabling.
 *   3. Stored decision — `~/.horus/telemetry.json` (Tier A default on, Tier B
 *      default off).
 *
 * Tier A = anonymous usage metadata. Tier B = redacted input/output content.
 * Env can toggle the Tier A gate on/off; Tier B is only ever enabled through an
 * explicit `horus telemetry enable-content`, never via env.
 */
import { readTelemetryState, type TelemetryState } from './store.js';

export type ConsentSource = 'env' | 'ci' | 'state' | 'default';

export interface ConsentDecision {
  /** Anonymous usage metadata allowed. */
  tierA: boolean;
  /** Redacted input/output content allowed. */
  tierB: boolean;
  /** True when an env hard opt-out is in effect (DO_NOT_TRACK / HORUS_TELEMETRY off). */
  forcedOff: boolean;
  source: ConsentSource;
  reason: string;
}

const OFF_VALUES = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled']);
const ON_VALUES = new Set(['1', 'true', 'on', 'yes', 'enable', 'enabled', 'all']);

const CI_ENV_VARS = [
  'CI',
  'CONTINUOUS_INTEGRATION',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TRAVIS',
  'JENKINS_URL',
  'TEAMCITY_VERSION',
];

/** `DO_NOT_TRACK` is honored when set to anything other than empty/0/false. */
function doNotTrack(env: NodeJS.ProcessEnv): boolean {
  const v = env.DO_NOT_TRACK;
  if (v == null || v === '') return false;
  return !OFF_VALUES.has(v.trim().toLowerCase());
}

/** Parse `HORUS_TELEMETRY` into an explicit on/off, or undefined when unset. */
function parseEnvFlag(value: string | undefined): 'on' | 'off' | undefined {
  if (value == null || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (OFF_VALUES.has(v)) return 'off';
  if (ON_VALUES.has(v)) return 'on';
  return undefined;
}

export function isCI(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_ENV_VARS.some((key) => {
    const v = env[key];
    return v != null && v !== '' && !OFF_VALUES.has(v.trim().toLowerCase());
  });
}

function off(source: ConsentSource, reason: string): ConsentDecision {
  return { tierA: false, tierB: false, forcedOff: source === 'env', source, reason };
}

/**
 * Resolve the effective consent decision. Reads `~/.horus/telemetry.json`
 * unless a `state` is supplied (tests pass it explicitly to stay hermetic).
 */
export function resolveConsent(
  opts: { env?: NodeJS.ProcessEnv; state?: TelemetryState | null } = {},
): ConsentDecision {
  const env = opts.env ?? process.env;
  const state = opts.state !== undefined ? opts.state : readTelemetryState();

  // 1. Hard opt-out via env wins over everything.
  if (doNotTrack(env)) return off('env', 'DO_NOT_TRACK is set');
  const envFlag = parseEnvFlag(env.HORUS_TELEMETRY);
  if (envFlag === 'off') return off('env', 'HORUS_TELEMETRY disables telemetry');

  const storedTierA = state?.tierA.enabled ?? true;
  const storedTierB = state?.tierB.enabled ?? false;

  // 2. CI collects nothing unless explicitly enabled.
  if (isCI(env) && envFlag !== 'on') {
    return {
      tierA: false,
      tierB: false,
      forcedOff: false,
      source: 'ci',
      reason: 'CI environment detected — telemetry off by default',
    };
  }

  // 3. Explicit env enable turns the Tier A gate on; Tier B still needs opt-in.
  if (envFlag === 'on') {
    return {
      tierA: true,
      tierB: storedTierB,
      forcedOff: false,
      source: 'env',
      reason: 'HORUS_TELEMETRY enables usage metadata',
    };
  }

  return {
    tierA: storedTierA,
    tierB: storedTierB,
    forcedOff: false,
    source: state ? 'state' : 'default',
    reason: state ? 'from ~/.horus/telemetry.json' : 'default settings (no saved preference)',
  };
}

/** Convenience: is anonymous usage metadata (Tier A) collection allowed right now. */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConsent({ env }).tierA;
}

/** Convenience: is redacted content (Tier B) sharing allowed right now. */
export function isContentSharingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConsent({ env }).tierB;
}
