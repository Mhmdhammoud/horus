import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDbUrl, DEFAULT_DB_URL } from './db-url.js';
import { CloudDatabaseUrlError } from '@horus/db';

const LOCAL = 'postgresql://horus:horus@localhost:5433/horus';

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('resolveDbUrl guardrail (HOR-298)', () => {
  let tmp: string;
  let origCwd: string;
  const savedDb = process.env['DATABASE_URL'];
  const savedCloud = process.env['HORUS_CLOUD_DATABASE_URL'];

  beforeEach(() => {
    origCwd = process.cwd();
    // An empty temp dir with no .horus/config.json — resolveDbUrl falls back to
    // DATABASE_URL, so these tests don't depend on any ambient repo config.
    tmp = mkdtempSync(join(tmpdir(), 'horus-dburl-'));
    process.chdir(tmp);
    delete process.env['DATABASE_URL'];
    delete process.env['HORUS_CLOUD_DATABASE_URL'];
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
    restore('DATABASE_URL', savedDb);
    restore('HORUS_CLOUD_DATABASE_URL', savedCloud);
  });

  it('resolves the local DATABASE_URL', async () => {
    process.env['DATABASE_URL'] = LOCAL;
    await expect(resolveDbUrl()).resolves.toBe(LOCAL);
  });

  it('falls back to the local default when DATABASE_URL is unset', async () => {
    await expect(resolveDbUrl()).resolves.toBe(DEFAULT_DB_URL);
  });

  it('refuses a DATABASE_URL pointing at the Cloud port (5434)', async () => {
    process.env['DATABASE_URL'] = 'postgresql://horus:pw@localhost:5434/horus';
    await expect(resolveDbUrl()).rejects.toBeInstanceOf(CloudDatabaseUrlError);
  });

  it('refuses a DATABASE_URL pointing at the Cloud database name (horus_cloud)', async () => {
    process.env['DATABASE_URL'] = 'postgresql://horus:pw@localhost:5433/horus_cloud';
    await expect(resolveDbUrl()).rejects.toBeInstanceOf(CloudDatabaseUrlError);
  });

  it('selecting a cloud context does NOT change the local DB connection', async () => {
    // Bind this repo to a cloud project (.horus/cloud.json, context: "cloud")…
    mkdirSync(join(tmp, '.horus'), { recursive: true });
    writeFileSync(
      join(tmp, '.horus', 'cloud.json'),
      JSON.stringify({
        context: 'cloud',
        organization: { id: 'o1', slug: 'meritt-dev' },
        workspace: { id: 'w1', slug: 'internal' },
        project: { id: 'p1', slug: 'horus' },
      }),
    );
    process.env['DATABASE_URL'] = LOCAL;
    // …the CLI still resolves its LOCAL database. Cloud selection is API-sync only.
    await expect(resolveDbUrl()).resolves.toBe(LOCAL);
  });
});
