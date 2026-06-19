/**
 * Local-vs-Cloud database guardrail (HOR-298).
 *
 * The Horus CLI's local Postgres (its execution state) and the Horus Cloud
 * Postgres (the shared team source of truth) are deliberately separate. The CLI
 * must reach Cloud ONLY through the `/v1` REST API — never by repointing its own
 * `DATABASE_URL` at the Cloud database. This guard makes that boundary
 * un-bypassable at the connection chokepoint: any attempt to open a CLI database
 * connection against the Cloud database throws.
 *
 * See `docs/cloud-vs-cli-databases.md`.
 */

/** Known Horus Cloud database markers (see horus-cloud docker-compose + .env). */
const CLOUD_DB_NAME = 'horus_cloud';
const CLOUD_DB_PORT = '5434';

export class CloudDatabaseUrlError extends Error {
  constructor(reason: string) {
    super(
      `Refusing to connect: DATABASE_URL points at the Horus Cloud database (${reason}). ` +
        `The Horus CLI must use only its LOCAL database (default port 5433, db "horus"); ` +
        `Cloud is reached through the /v1 REST API, never a direct DB connection. ` +
        `Fix your DATABASE_URL (do not set it to the Cloud database / HORUS_CLOUD_DATABASE_URL). ` +
        `See docs/cloud-vs-cli-databases.md.`,
    );
    this.name = 'CloudDatabaseUrlError';
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Why a URL looks like the Horus Cloud database, or `null` if it looks local.
 * Pure + side-effect free except for reading `HORUS_CLOUD_DATABASE_URL` from env.
 */
export function cloudDatabaseUrlReason(url: string): string | null {
  if (!url) return null;

  // Strongest signal: exact match to the configured Cloud DB URL.
  const cloudEnv = process.env['HORUS_CLOUD_DATABASE_URL'];
  if (cloudEnv && normalizeUrl(url) === normalizeUrl(cloudEnv)) {
    return 'matches HORUS_CLOUD_DATABASE_URL';
  }

  // Structured check via the URL parser; fall back to substring matching for
  // connection strings the WHATWG parser can't handle.
  try {
    const u = new URL(url);
    const dbName = u.pathname.replace(/^\/+/, '');
    if (dbName === CLOUD_DB_NAME) return `database name "${CLOUD_DB_NAME}"`;
    if (u.port === CLOUD_DB_PORT) return `Cloud port ${CLOUD_DB_PORT}`;
    return null;
  } catch {
    if (new RegExp(`/${CLOUD_DB_NAME}(\\b|$)`).test(url)) return `database name "${CLOUD_DB_NAME}"`;
    if (url.includes(`:${CLOUD_DB_PORT}`)) return `Cloud port ${CLOUD_DB_PORT}`;
    return null;
  }
}

/** True if `url` appears to point at the Horus Cloud database. */
export function looksLikeCloudDatabaseUrl(url: string): boolean {
  return cloudDatabaseUrlReason(url) !== null;
}

/**
 * Throw if `url` points at the Horus Cloud database. Call at every point that
 * opens a CLI database connection so the boundary can't be crossed silently.
 */
export function assertLocalDatabaseUrl(url: string): void {
  const reason = cloudDatabaseUrlReason(url);
  if (reason) throw new CloudDatabaseUrlError(reason);
}
