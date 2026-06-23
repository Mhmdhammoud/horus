import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDb, shouldUseEmbeddedDb } from './client.js';
import { investigations, incidentMemory } from './schema.js';
import { eq } from 'drizzle-orm';

const DEFAULT = 'postgresql://horus:horus@localhost:5433/horus';

describe('shouldUseEmbeddedDb (driver selection)', () => {
  const saved = process.env['DATABASE_URL'];
  beforeEach(() => {
    delete process.env['DATABASE_URL'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = saved;
  });

  it('uses embedded for empty/unset url', () => {
    expect(shouldUseEmbeddedDb(undefined)).toBe(true);
    expect(shouldUseEmbeddedDb('')).toBe(true);
    expect(shouldUseEmbeddedDb('   ')).toBe(true);
  });

  it('uses embedded for the local-default placeholder when DATABASE_URL is unset', () => {
    expect(shouldUseEmbeddedDb(DEFAULT)).toBe(true);
  });

  it('uses postgres-js when DATABASE_URL is explicitly set', () => {
    process.env['DATABASE_URL'] = DEFAULT;
    expect(shouldUseEmbeddedDb(DEFAULT)).toBe(false);
  });

  it('uses postgres-js for a non-default configured url', () => {
    expect(shouldUseEmbeddedDb('postgresql://u:p@db.example.com:5432/app')).toBe(false);
  });
});

describe('createLocalDb (embedded pglite)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'horus-db-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies migrations and round-trips investigations + incident_memory', async () => {
    const { db, sql } = await createLocalDb({ path: join(dir, 'horus.db') });
    try {
      const ins = await db
        .insert(investigations)
        .values({
          title: 'Test incident',
          incidentInput: { hint: 'queue backlog', repo: 'r', nested: { a: [1, 2] } },
          status: 'open',
          summary: 's',
          report: { confidence: 0.5 },
        })
        .returning({ id: investigations.id });
      const id = ins[0]!.id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);

      await db.insert(incidentMemory).values({
        investigationId: id,
        project: 'r',
        title: 'queue backlog',
        tags: ['mod/area', 'queue-x'], // text[]
        payload: { confidence: 0.5 }, // jsonb
      });

      const back = await db.select().from(investigations).where(eq(investigations.id, id));
      expect(back[0]!.createdAt).toBeInstanceOf(Date);
      expect(back[0]!.incidentInput).toEqual({ hint: 'queue backlog', repo: 'r', nested: { a: [1, 2] } });

      const mem = await db.select().from(incidentMemory).where(eq(incidentMemory.project, 'r'));
      expect(mem[0]!.tags).toEqual(['mod/area', 'queue-x']);
    } finally {
      await sql.end();
    }
  }, 30_000);

  it('is idempotent: re-opening an existing db does not re-run migrations or lose data', async () => {
    const path = join(dir, 'horus.db');
    const first = await createLocalDb({ path });
    await first.db.insert(investigations).values({
      title: 'persisted',
      incidentInput: {},
      summary: null,
    });
    await first.sql.end();

    const second = await createLocalDb({ path });
    try {
      const rows = await second.db.select().from(investigations);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.title).toBe('persisted');
    } finally {
      await second.sql.end();
    }
  }, 30_000);

  it('gap 7: holds a write-lock for the session and releases it on close', async () => {
    const path = join(dir, 'horus.db');
    const lockPath = `${path}.lock`;
    const h = await createLocalDb({ path });
    expect(existsSync(lockPath)).toBe(true); // lock held while the session is open
    await h.sql.end();
    expect(existsSync(lockPath)).toBe(false); // released on close, so the next run can acquire it
  }, 30_000);
});
