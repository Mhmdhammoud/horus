/**
 * HOR-319 (Bug 2) — self-heal a down source-intelligence host.
 *
 * `horus investigate` used to exit 1 the moment `code.health()` failed. Instead we try
 * to restart a previously-indexed host at its configured port before giving up, so a
 * transient host outage degrades into a brief auto-start rather than a dead end.
 *
 * This composes the canonical host-lifecycle primitives owned by HOR-SOURCE
 * (@horus/connectors) — it does NOT reimplement host management, and it never performs
 * first-time analysis (that remains the job of `horus index`).
 */
import {
  isHostHealthy,
  sourceAvailable,
  assertSourceVersionPinned,
  isAnalyzed,
  startHost,
  waitForHost,
  removeSpawnedHostRecord,
  reconcileSpawnedHostPid,
} from '@horus/connectors';

export type EnsureHostReason =
  | 'source-unavailable'
  | 'version-mismatch'
  | 'not-analyzed'
  | 'bad-url'
  | 'unhealthy';

export interface EnsureHostResult {
  ok: boolean;
  /** The healthy host URL when ok === true. */
  hostUrl?: string;
  /** Why a self-heal attempt could not proceed, when ok === false. */
  reason?: EnsureHostReason;
}

/** Parse the TCP port from a host URL (e.g. `http://127.0.0.1:8420` → 8420). */
export function parseHostPort(hostUrl: string): number | null {
  try {
    const port = parseInt(new URL(hostUrl).port, 10);
    return Number.isNaN(port) ? null : port;
  } catch {
    return null;
  }
}

/** Human-readable next step for why a self-heal attempt could not proceed. */
export function ensureHostReasonHint(reason: EnsureHostReason | undefined): string {
  switch (reason) {
    case 'source-unavailable':
      return 'horus-source is not installed — install it: pip install horus-source';
    case 'version-mismatch':
      return 'the installed horus-source backend does not match the version Horus is pinned to — reinstall the pinned version (run `horus status` to see it)';
    case 'not-analyzed':
      return 'this repo has not been indexed yet — run: horus index';
    case 'bad-url':
      return 'the configured source host URL is not a valid URL';
    default:
      return 'the host did not become healthy — run: horus index';
  }
}

/**
 * Try to make the source-intelligence host at `hostUrl` healthy, restarting it at the
 * SAME port if it is down — so an existing CodeProvider pointed at `hostUrl` keeps
 * working without a rebuild. Only restarts a repo that is already analyzed; it never
 * triggers first-time analysis.
 */
export async function ensureSourceHost(
  root: string,
  hostUrl: string,
  opts: { timeoutMs?: number } = {},
): Promise<EnsureHostResult> {
  // Maybe it recovered between the caller's health check and now.
  if (await isHostHealthy(hostUrl)) return { ok: true, hostUrl };

  // We can only restart a real, analyzed repo with the source backend installed.
  if (!(await sourceAvailable())) return { ok: false, reason: 'source-unavailable' };
  // Never restart a host with a drifted backend — it would re-corrupt the graph the same
  // way `horus index` would. Mirror that guard here so self-heal can't smuggle one in.
  try {
    await assertSourceVersionPinned();
  } catch {
    return { ok: false, reason: 'version-mismatch' };
  }
  if (!isAnalyzed(root)) return { ok: false, reason: 'not-analyzed' };

  const port = parseHostPort(hostUrl);
  if (port === null) return { ok: false, reason: 'bad-url' };

  startHost(root, port);
  if (await waitForHost(hostUrl, opts.timeoutMs ?? 20_000)) {
    // Make the ownership record point at the backend's real server pid (host.json) so a
    // later `horus stop` signals the process that actually holds the port + Kùzu lock.
    reconcileSpawnedHostPid(root, port);
    return { ok: true, hostUrl };
  }

  // Never became healthy — drop the ownership record so `horus stop` doesn't chase a
  // dead PID (mirrors index-repo's behaviour on a failed spawn).
  removeSpawnedHostRecord(root);
  return { ok: false, reason: 'unhealthy' };
}
