import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type HorusDb = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: HorusDb;
  /** The underlying postgres-js client — close it with `sql.end()` when done. */
  sql: postgres.Sql;
}

/**
 * Create a Drizzle client bound to the Horus schema. Caller owns the lifecycle and
 * should call `handle.sql.end()` on shutdown (e.g. after a one-shot CLI command).
 */
export function createDb(url: string, opts?: { max?: number }): DbHandle {
  const sql = postgres(url, { max: opts?.max ?? 5, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql };
}
