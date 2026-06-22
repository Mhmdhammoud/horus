/**
 * Filesystem locations for Horus usage-telemetry state (HOR-323, epic HOR-322).
 *
 * Lives in the global Horus home next to `auth.json`, reusing the same
 * `~/.horus` convention and the `HORUS_HOME` override so tests and CI can point
 * it at a scratch dir. Nothing here is repo-scoped: the install identity and
 * consent decision belong to the machine/user, not a single checkout.
 */
import { join } from 'node:path';
import { horusHome } from '../cloud/paths.js';

export const TELEMETRY_FILE = 'telemetry.json';
export const TELEMETRY_QUEUE_DIR = 'telemetry-queue';

/** Consent + install-identity file: `~/.horus/telemetry.json`. */
export function telemetryPath(): string {
  return join(horusHome(), TELEMETRY_FILE);
}

/**
 * Offline spool directory for not-yet-uploaded events: `~/.horus/telemetry-queue/`.
 * Defined here so Phase 1 (HOR-324) can reuse it; unused in Phase 0.
 */
export function telemetryQueueDir(): string {
  return join(horusHome(), TELEMETRY_QUEUE_DIR);
}
