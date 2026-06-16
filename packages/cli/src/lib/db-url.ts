import { loadConfig } from '@horus/core';

/** Local-default Postgres URL, matching the docker-compose dev instance. */
export const DEFAULT_DB_URL = 'postgresql://horus:horus@localhost:5433/horus';

/**
 * Resolve the Postgres URL for database-backed commands (investigations, replay,
 * score, ask, postmortem). These commands need only the database, not a project
 * config — they operate on investigation rows that already live in Postgres. So
 * when no config is discoverable from the cwd, fall back to DATABASE_URL / the
 * local default instead of hard-failing. This lets these commands run from any
 * directory, not just inside a configured repo (HOR-150 follow-up).
 *
 * When a config *is* loadable, its `database.url` already incorporates the same
 * DATABASE_URL / default fallback (see config loadConfigFile), so this returns a
 * consistent URL in both branches.
 */
export async function resolveDbUrl(configPath?: string): Promise<string> {
  try {
    const config = await loadConfig(configPath);
    return config.database.url;
  } catch {
    return process.env['DATABASE_URL'] ?? DEFAULT_DB_URL;
  }
}
