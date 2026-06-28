import postgres from 'postgres';

/** The tables the first migration must have created. */
export const EXPECTED_TABLES = [
  'projects',
  'repositories',
  'investigations',
  'evidence',
  'findings',
  'hypotheses',
  'incident_memory',
  'memory_item',
  'memory_link',
  'memory_audit',
  'outcome_label',
  'queue_edges',
  'provider_cache',
] as const;

export interface DbHealth {
  /** Postgres is reachable and accepting queries. */
  reachable: boolean;
  /** All expected tables exist (migrations have been applied). */
  schemaReady: boolean;
  reachableDetail: string;
  schemaDetail: string;
}

/**
 * Probe Postgres for `horus status`: is it reachable, and is the schema migrated?
 * Never throws — failures are reported as `false` with a human detail.
 */
export async function checkDatabase(url: string): Promise<DbHealth> {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY(${[...EXPECTED_TABLES]})
    `;
    const present = new Set(rows.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    return {
      reachable: true,
      schemaReady: missing.length === 0,
      reachableDetail: 'connected',
      schemaDetail:
        missing.length === 0
          ? `${EXPECTED_TABLES.length} tables present`
          : `missing: ${missing.join(', ')} — run \`pnpm db migrate\``,
    };
  } catch (err) {
    return {
      reachable: false,
      schemaReady: false,
      reachableDetail: `unreachable — \`docker compose up -d\` (${(err as Error).message})`,
      schemaDetail: 'cannot check — Postgres unreachable',
    };
  } finally {
    await sql.end({ timeout: 2 });
  }
}
