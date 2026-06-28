/**
 * Unit tests for the outcome-label / eval store (HOR-390).
 *
 * Runs against the embedded pglite DB so we exercise the real schema + the inlined
 * EMBEDDED_MIGRATIONS (bundle parity — single-file CLI installs rely on it, not drizzle/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createLocalDb, type DbHandle } from './client.js';
import { investigations } from './schema.js';
import {
  recordOutcomeLabel,
  listOutcomeLabels,
  getLatestOutcomeLabel,
  isOutcomeResolved,
  isOutcomeSource,
  OUTCOME_RESOLVED,
  OUTCOME_SOURCE,
} from './outcome.js';

describe('outcome label validation (pure)', () => {
  it('isOutcomeResolved accepts only yes|partly|no', () => {
    for (const v of OUTCOME_RESOLVED) expect(isOutcomeResolved(v)).toBe(true);
    for (const v of ['maybe', '', 'YES', null, undefined, 1]) expect(isOutcomeResolved(v)).toBe(false);
  });

  it('isOutcomeSource accepts only feedback|confirm', () => {
    for (const v of OUTCOME_SOURCE) expect(isOutcomeSource(v)).toBe(true);
    for (const v of ['prompt', 'flag', '', null]) expect(isOutcomeSource(v)).toBe(false);
  });
});

describe('outcome store (embedded pglite)', () => {
  let dir: string;
  let handle: DbHandle;

  async function seedInvestigation(title: string): Promise<string> {
    const ins = await handle.db
      .insert(investigations)
      .values({ title, incidentInput: {}, summary: null })
      .returning({ id: investigations.id });
    return ins[0]!.id;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'horus-outcome-test-'));
    handle = await createLocalDb({ path: join(dir, 'horus.db') });
  });
  afterEach(async () => {
    await handle.sql.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it('0008: records and round-trips an outcome label from the embedded bundle', async () => {
    const id = await seedInvestigation('queue backlog');
    const row = await recordOutcomeLabel(handle.db, {
      investigationId: id,
      resolved: 'yes',
      source: 'confirm',
      confirmedCause: 'consumer never acked',
      note: 'spot on',
      project: 'leadcall-api',
      payload: { horusSeconds: 12 },
    });

    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.resolved).toBe('yes');
    expect(row.source).toBe('confirm');
    expect(row.confirmedCause).toBe('consumer never acked');
    expect(row.note).toBe('spot on');
    expect(row.project).toBe('leadcall-api');
    expect(row.payload).toEqual({ horusSeconds: 12 });
    expect(row.at).toBeInstanceOf(Date);

    const back = await listOutcomeLabels(handle.db, { investigationId: id });
    expect(back).toHaveLength(1);
    expect(back[0]!.id).toBe(row.id);
  }, 30_000);

  it('defaults the optional fields to null', async () => {
    const id = await seedInvestigation('minimal');
    const row = await recordOutcomeLabel(handle.db, {
      investigationId: id,
      resolved: 'no',
      source: 'feedback',
    });
    expect(row.confirmedCause).toBeNull();
    expect(row.note).toBeNull();
    expect(row.project).toBeNull();
    expect(row.payload).toBeNull();
  }, 30_000);

  it('rejects an invalid resolved/source before touching the DB', async () => {
    const id = await seedInvestigation('bad');
    await expect(
      // @ts-expect-error — deliberately invalid verdict
      recordOutcomeLabel(handle.db, { investigationId: id, resolved: 'maybe', source: 'confirm' }),
    ).rejects.toThrow(/invalid resolved/);
    await expect(
      // @ts-expect-error — deliberately invalid source
      recordOutcomeLabel(handle.db, { investigationId: id, resolved: 'yes', source: 'prompt' }),
    ).rejects.toThrow(/invalid source/);
    expect(await listOutcomeLabels(handle.db)).toHaveLength(0); // nothing persisted
  }, 30_000);

  it('is append-only: multiple labels per investigation; getLatest collapses to newest `at`', async () => {
    const id = await seedInvestigation('evolving');
    await recordOutcomeLabel(handle.db, {
      investigationId: id,
      resolved: 'partly',
      source: 'feedback',
      at: new Date('2026-06-20T10:00:00Z'),
    });
    await recordOutcomeLabel(handle.db, {
      investigationId: id,
      resolved: 'yes',
      source: 'confirm',
      confirmedCause: 'found it',
      at: new Date('2026-06-25T10:00:00Z'),
    });

    const all = await listOutcomeLabels(handle.db, { investigationId: id });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.resolved)).toEqual(['yes', 'partly']); // newest-first

    const latest = await getLatestOutcomeLabel(handle.db, id);
    expect(latest!.resolved).toBe('yes');
    expect(latest!.confirmedCause).toBe('found it');

    expect(await getLatestOutcomeLabel(handle.db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  }, 30_000);

  it('filters by project, source, resolved, and date range', async () => {
    const a = await seedInvestigation('A');
    const b = await seedInvestigation('B');
    await recordOutcomeLabel(handle.db, {
      investigationId: a,
      resolved: 'yes',
      source: 'confirm',
      project: 'proj-a',
      at: new Date('2026-06-01T00:00:00Z'),
    });
    await recordOutcomeLabel(handle.db, {
      investigationId: a,
      resolved: 'no',
      source: 'feedback',
      project: 'proj-a',
      at: new Date('2026-06-10T00:00:00Z'),
    });
    await recordOutcomeLabel(handle.db, {
      investigationId: b,
      resolved: 'partly',
      source: 'feedback',
      project: 'proj-b',
      at: new Date('2026-06-15T00:00:00Z'),
    });

    expect(await listOutcomeLabels(handle.db)).toHaveLength(3);
    expect((await listOutcomeLabels(handle.db, { project: 'proj-a' })).map((r) => r.resolved)).toEqual([
      'no',
      'yes',
    ]);
    expect(await listOutcomeLabels(handle.db, { source: 'feedback' })).toHaveLength(2);
    expect(await listOutcomeLabels(handle.db, { resolved: 'yes' })).toHaveLength(1);
    expect(await listOutcomeLabels(handle.db, { project: 'proj-a', resolved: 'no' })).toHaveLength(1);

    // Date range (inclusive bounds).
    const ranged = await listOutcomeLabels(handle.db, {
      since: new Date('2026-06-05T00:00:00Z'),
      until: new Date('2026-06-12T00:00:00Z'),
    });
    expect(ranged).toHaveLength(1);
    expect(ranged[0]!.project).toBe('proj-a');

    expect(await listOutcomeLabels(handle.db, { limit: 2 })).toHaveLength(2);
  }, 30_000);

  it('cascades: deleting the investigation removes its labels', async () => {
    const id = await seedInvestigation('doomed');
    await recordOutcomeLabel(handle.db, { investigationId: id, resolved: 'yes', source: 'confirm' });
    await handle.db.delete(investigations).where(eq(investigations.id, id));
    expect(await listOutcomeLabels(handle.db, { investigationId: id })).toHaveLength(0);
  }, 30_000);
});
