/**
 * Persistent telemetry state: `~/.horus/telemetry.json` (HOR-323, epic HOR-322).
 *
 * Holds two things and nothing else:
 *   - a stable, random `installId` (no PII, no machine fingerprint) so usage can
 *     be deduped without identifying a person, and
 *   - the user's two-tier consent decision (Tier A = anonymous usage metadata,
 *     Tier B = redacted inputs/outputs content).
 *
 * Written with mode 0600, mirroring `auth-store.ts`. This module is pure
 * storage: env overrides (`DO_NOT_TRACK`, `HORUS_TELEMETRY`, CI detection) live
 * in `consent.ts`, which is the only thing that should decide whether we
 * actually collect.
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { horusHome } from '../cloud/paths.js';
import { telemetryPath } from './paths.js';

export const TELEMETRY_SCHEMA_VERSION = 1;

export interface TierAState {
  /** Anonymous usage metadata. Default on (with notice + easy opt-out). */
  enabled: boolean;
  /** ISO timestamp the one-time first-run notice was displayed, or null. */
  noticeShownAt: string | null;
}

export interface TierBState {
  /** Redacted input/output content. Default off — explicit opt-in only. */
  enabled: boolean;
  /** ISO timestamp content sharing was turned on, or null. */
  enabledAt: string | null;
}

export interface TelemetryState {
  schemaVersion: number;
  /** Random v4 UUID, generated once, user-resettable. Not a fingerprint. */
  installId: string;
  tierA: TierAState;
  tierB: TierBState;
  createdAt: string;
  updatedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** A fresh state with collection defaults: Tier A on, Tier B off. */
export function defaultTelemetryState(installId: string = randomUUID()): TelemetryState {
  const now = nowIso();
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    installId,
    tierA: { enabled: true, noticeShownAt: null },
    tierB: { enabled: false, enabledAt: null },
    createdAt: now,
    updatedAt: now,
  };
}

/** Coerce an unknown parsed blob into a valid state, or return null if unusable. */
function coerce(raw: unknown): TelemetryState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.installId !== 'string' || r.installId.length === 0) return null;
  const tierA = (r.tierA ?? {}) as Record<string, unknown>;
  const tierB = (r.tierB ?? {}) as Record<string, unknown>;
  return {
    schemaVersion:
      typeof r.schemaVersion === 'number' ? r.schemaVersion : TELEMETRY_SCHEMA_VERSION,
    installId: r.installId,
    tierA: {
      enabled: typeof tierA.enabled === 'boolean' ? tierA.enabled : true,
      noticeShownAt: typeof tierA.noticeShownAt === 'string' ? tierA.noticeShownAt : null,
    },
    tierB: {
      enabled: typeof tierB.enabled === 'boolean' ? tierB.enabled : false,
      enabledAt: typeof tierB.enabledAt === 'string' ? tierB.enabledAt : null,
    },
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : nowIso(),
  };
}

/** Read state from disk. Returns null when missing or unreadable/corrupt. */
export function readTelemetryState(): TelemetryState | null {
  const p = telemetryPath();
  if (!existsSync(p)) return null;
  try {
    return coerce(JSON.parse(readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

/** Persist state with 0600 perms, tightening even if the file pre-existed. */
export function writeTelemetryState(state: TelemetryState): void {
  mkdirSync(horusHome(), { recursive: true });
  const p = telemetryPath();
  // Write to a temp file then rename, so a crash or a concurrent run can never
  // observe a half-written telemetry.json (readTelemetryState would treat a torn
  // file as missing and re-init, churning the installId).
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  try {
    renameSync(tmp, p);
  } catch (err) {
    try {
      rmSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  // Tighten perms even if the destination pre-existed with a looser mode.
  try {
    chmodSync(p, 0o600);
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

/** Read existing state, or create+persist a fresh one (generating an installId). */
export function loadOrInitTelemetryState(): TelemetryState {
  const existing = readTelemetryState();
  if (existing) return existing;
  const created = defaultTelemetryState();
  writeTelemetryState(created);
  return created;
}

/**
 * Load, mutate, bump `updatedAt`, and persist in one step. The mutator receives
 * the live object and should set fields on it directly.
 */
export function updateTelemetryState(
  mutate: (state: TelemetryState) => void,
): TelemetryState {
  const state = loadOrInitTelemetryState();
  mutate(state);
  state.updatedAt = nowIso();
  writeTelemetryState(state);
  return state;
}

/** Delete the local telemetry file entirely (used by `horus telemetry delete`). */
export function deleteTelemetryState(): void {
  const p = telemetryPath();
  if (existsSync(p)) rmSync(p);
}
