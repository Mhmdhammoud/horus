import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus',
  },
  // No pgvector / extensions in v0.
  strict: true,
  verbose: true,
});
