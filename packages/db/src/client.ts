import { drizzle } from 'drizzle-orm/postgres-js';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import * as schema from './schema.js';
import { assertLocalDatabaseUrl } from './guard.js';
import { EMBEDDED_MIGRATIONS } from './migrations-bundle.js';

/**
 * Horus's Drizzle handle, typed as the common Postgres base so a query written against
 * it runs identically on the two local drivers Horus uses:
 *   - postgres-js  → a user-run local Postgres (when DATABASE_URL is configured)
 *   - pglite       → an embedded, file-backed database (the zero-setup default)
 *
 * Both `PostgresJsDatabase` and `PgliteDatabase` extend this `PgDatabase`, so every
 * `.select()/.insert()/.update()/.returning()` the engine and db helpers use is
 * available — and using the base (rather than a union of the two concrete classes)
 * keeps overload resolution intact (a union collapses `.returning()` to 0 args).
 */
export type HorusDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * A closeable handle around the active database. `sql.end()` releases resources for
 * either driver (postgres-js connection pool, or the embedded pglite instance), so the
 * one-shot-CLI shutdown path (`await handle.sql.end()`) is identical regardless of driver.
 */
export interface DbHandle {
  db: HorusDb;
  /** Release the underlying resources. Call once on shutdown. */
  sql: { end: () => Promise<void> };
}

/**
 * Create a Drizzle client bound to a user-run **local Postgres**. Caller owns the
 * lifecycle and should call `handle.sql.end()` on shutdown (e.g. after a one-shot CLI
 * command).
 */
export function createDb(url: string, opts?: { max?: number }): DbHandle {
  // Guardrail (HOR-298): the CLI must never open a connection to the Cloud DB.
  assertLocalDatabaseUrl(url);
  const sql = postgres(url, { max: opts?.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

/** Default location for the embedded local database (override with HORUS_DB_DIR). */
export function localDbPath(): string {
  const dir = process.env['HORUS_DB_DIR'] || join(homedir(), '.horus');
  return join(dir, 'horus.db');
}

/**
 * The local-default Postgres URL the config layer fills in when the user has NOT
 * configured a database. Reaching this value means "no user-run Postgres" — the signal
 * to fall back to the embedded pglite database. Kept in sync with core's DEFAULT_DB_URL.
 */
const DEFAULT_LOCAL_PG_URL = 'postgresql://horus:horus@localhost:5433/horus';

/**
 * Decide whether a given resolved database URL means "use the embedded pglite database".
 *
 * True when the user has not actually configured a Postgres: the URL is empty/unset, or
 * it is the local-default placeholder AND no DATABASE_URL was explicitly set in the env.
 * Any explicit DATABASE_URL (or a `database` block in config that yields a non-default
 * url) opts into the postgres-js driver, preserving existing local-Postgres workflows.
 */
export function shouldUseEmbeddedDb(url: string | undefined): boolean {
  const u = (url ?? '').trim();
  if (u === '') return true;
  const envSet = (process.env['DATABASE_URL'] ?? '').trim() !== '';
  if (envSet) return false;
  return u === DEFAULT_LOCAL_PG_URL;
}

/**
 * Open the right database for a resolved url: the embedded pglite database when no
 * user-run Postgres is configured (the zero-setup default), otherwise the user's local
 * Postgres via postgres-js. This is the single chokepoint CLI commands should use so the
 * driver choice is consistent everywhere.
 */
export async function openDb(url: string | undefined, opts?: { max?: number }): Promise<DbHandle> {
  if (shouldUseEmbeddedDb(url)) return createLocalDb();
  return createDb(url as string, opts);
}

const migrationsApplied = new WeakSet<PGlite>();

/**
 * Apply the embedded migrations to a pglite instance idempotently. Tracks applied
 * migration tags in `__horus_migrations` so re-opening an existing DB is a no-op, and a
 * partially-applied DB resumes from where it left off. Statements are wrapped in IF
 * (NOT) EXISTS-style guards where drizzle doesn't emit them, by skipping any whole
 * migration tag that has already been recorded.
 */
async function applyEmbeddedMigrations(client: PGlite): Promise<void> {
  if (migrationsApplied.has(client)) return;
  await client.exec(
    `CREATE TABLE IF NOT EXISTS "__horus_migrations" (
       "tag" text PRIMARY KEY,
       "applied_at" timestamptz NOT NULL DEFAULT now()
     );`,
  );
  const doneRes = await client.query<{ tag: string }>(`SELECT tag FROM "__horus_migrations";`);
  const done = new Set(doneRes.rows.map((r) => r.tag));

  for (const migration of EMBEDDED_MIGRATIONS) {
    if (done.has(migration.tag)) continue;
    // Each migration is its own transaction: either the whole tag applies or none of it,
    // so the recorded tag always reflects a fully-applied migration.
    await client.transaction(async (tx) => {
      for (const statement of migration.statements) {
        await tx.exec(statement);
      }
      await tx.query(`INSERT INTO "__horus_migrations" (tag) VALUES ($1);`, [migration.tag]);
    });
  }
  migrationsApplied.add(client);
}

/**
 * Create a Drizzle client bound to the **embedded, file-backed pglite database**
 * (default `~/.horus/horus.db`, overridable via `HORUS_DB_DIR`). This activates
 * incident memory, `horus ask`, `score`, and `feedback` with zero setup — no
 * user-run Postgres required.
 *
 * Migrations are embedded in the bundle and applied idempotently on first use, so the
 * file is created and brought to schema on demand. The returned `sql.end()` closes the
 * pglite instance.
 */
export async function createLocalDb(opts?: { path?: string }): Promise<DbHandle> {
  const dataDir = opts?.path ?? localDbPath();
  // pglite persists into a directory; ensure the parent exists.
  try {
    mkdirSync(dataDir.replace(/[^/]+$/, ''), { recursive: true });
  } catch {
    // best-effort; pglite will surface a clear error if the path is unusable.
  }
  const client = new PGlite(dataDir);
  await client.waitReady;
  await applyEmbeddedMigrations(client);
  const db = drizzlePglite(client, { schema });
  return {
    db,
    sql: {
      end: async () => {
        await client.close();
      },
    },
  };
}
