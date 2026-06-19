import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { assertLocalDatabaseUrl } from './guard.js';

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

/** Apply all pending migrations against `url`. Idempotent. */
export async function runMigrations(url: string): Promise<void> {
  // Guardrail (HOR-298): never migrate the Cloud DB from the CLI.
  assertLocalDatabaseUrl(url);
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder });
  } finally {
    await sql.end();
  }
}

// Allow `tsx src/migrate.ts` / `pnpm db migrate` as a standalone command.
// Guard against false positives when this module is bundled into another entry
// (e.g. tsup → apps/horus/dist/index.js): require the process entry to actually
// be the migrate module by name, so importing it never auto-runs migrations.
const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entry) &&
  basename(entry).replace(/\.[cm]?[jt]s$/, '') === 'migrate';
if (invokedDirectly) {
  const url = process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus';
  runMigrations(url)
    .then(() => {
      console.log('Migrations applied.');
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('Migration failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
