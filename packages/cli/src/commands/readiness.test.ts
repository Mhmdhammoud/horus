/**
 * HOR-97 — Release readiness command tests.
 *
 * Three canonical states:
 *   1. ready       — DB pass, Axon at pinned version, ES configured → exit 0, "Ready"
 *   2. partial     — DB pass, Axon missing, no global config → exit 0, warns about optional
 *   3. blocking    — DB unreachable → exit 1, "Not ready"
 *
 * All checks are injected; no live DB, Axon, or connector probes.
 */

import { describe, it, expect } from 'vitest';
import { runReadiness } from './readiness.js';
import { PINNED_AXON_VERSION } from '@horus/core';
import type { DbHealth } from '@horus/db';
import type { loadConfig } from '@horus/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(out: string[]): string {
  return out.join('\n');
}

function capture(): { out: string[]; write: (l: string) => void } {
  const out: string[] = [];
  return { out, write: (l: string) => out.push(l) };
}

const DB_PASS: DbHealth = { reachable: true, reachableDetail: 'connected', schemaReady: true, schemaDetail: 'v7 (7 tables)' };
const DB_NOT_REACHABLE: DbHealth = { reachable: false, reachableDetail: 'unreachable', schemaReady: false, schemaDetail: '' };
const DB_SCHEMA_MISSING: DbHealth = { reachable: true, reachableDetail: 'connected', schemaReady: false, schemaDetail: 'connected, no schema' };

function makeConfig(opts: {
  axonUrl?: string;
  elasticsearch?: boolean;
  grafana?: boolean;
  mongodb?: boolean;
  redis?: boolean;
}): Awaited<ReturnType<typeof loadConfig>> {
  const connectors: Record<string, unknown> = {};
  if (opts.elasticsearch) connectors['elasticsearch'] = { indexPattern: 'logs-*' };
  if (opts.grafana) connectors['grafana'] = { url: 'http://grafana.internal' };
  if (opts.mongodb) connectors['mongodb'] = { url: 'mongodb://localhost:27017', database: 'prod' };
  if (opts.redis) connectors['redis'] = { url: 'redis://localhost:6379' };

  return {
    database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
    projects: [
      {
        name: 'test-project',
        repositories: [
          {
            name: 'test-repo',
            path: '/tmp/test-repo',
            ...(opts.axonUrl ? { axon: { hostUrl: opts.axonUrl } } : {}),
          },
        ],
        environments: [
          {
            name: 'production',
            connectors: connectors as ReturnType<typeof loadConfig> extends Promise<infer T>
              ? never
              : never,
          },
        ],
      },
    ],
  } as unknown as Awaited<ReturnType<typeof loadConfig>>;
}

// ---------------------------------------------------------------------------
// 1. Ready state
// ---------------------------------------------------------------------------

describe('horus readiness — fully ready', () => {
  it('exits 0 when DB passes and Axon is at pinned version', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({ axonUrl: 'http://localhost:8420', elasticsearch: true }),
    });
    expect(code).toBe(0);
    expect(lines(out)).toContain('Ready');
  });

  it('marks CLI check as pass', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    expect(lines(out)).toContain('CLI');
  });

  it('marks Database check as pass with schema detail', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Database');
    expect(output).toContain('v7 (7 tables)');
  });

  it('marks Axon backend as pass when version matches pinned', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Axon backend');
    expect(output).toContain('ready');
  });

  it('marks Elasticsearch as pass when configured', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({ elasticsearch: true }),
    });
    expect(lines(out)).toContain('Elasticsearch');
    // Should not suggest running connect
    const relevant = lines(out).split('\n').find(l => l.includes('Elasticsearch'));
    expect(relevant).not.toContain('→');
  });
});

// ---------------------------------------------------------------------------
// 2. Partial state (DB pass, optional items missing)
// ---------------------------------------------------------------------------

describe('horus readiness — partial (DB pass, optional items missing)', () => {
  it('exits 0 when DB passes even with no global config', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(code).toBe(0);
  });

  it('output mentions optional items not configured', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('optional item');
  });

  it('shows Axon version mismatch as warn', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => '0.0.1',
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('version mismatch');
    expect(output).toContain(PINNED_AXON_VERSION);
  });

  it('Axon not installed — shows install hint', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('uv tool install axoniq');
  });

  it('global config missing — shows generate-config hint', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('generate-config');
  });

  it('no Axon host URL in config — shows warn for Repo / Axon host', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    const output = lines(out);
    expect(output).toContain('Repo / Axon host');
    expect(output).toContain('no Axon host URL');
  });

  it('connectors not configured — shows next steps', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_PASS,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    const output = lines(out);
    expect(output).toContain('horus connect elasticsearch');
    expect(output).toContain('horus connect grafana');
    expect(output).toContain('horus connect mongodb');
    expect(output).toContain('horus connect redis');
  });
});

// ---------------------------------------------------------------------------
// 3. Blocking state (DB not reachable / schema missing)
// ---------------------------------------------------------------------------

describe('horus readiness — blocking (DB failure)', () => {
  it('exits 1 when DB is not reachable', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(code).toBe(1);
  });

  it('output contains "Not ready" when DB unreachable', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('Not ready');
  });

  it('shows docker run hint when DB unreachable', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('docker run');
  });

  it('exits 1 when DB reachable but schema missing', async () => {
    const { out, write } = capture();
    const code = await runReadiness({
      write,
      _dbCheck: async () => DB_SCHEMA_MISSING,
      _axonVersion: async () => PINNED_AXON_VERSION,
      _loadConfig: async () => makeConfig({}),
    });
    expect(code).toBe(1);
  });

  it('shows migration hint when schema missing', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_SCHEMA_MISSING,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('pnpm db migrate');
  });

  it('output separates Blocking from Optional sections', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    const output = lines(out);
    expect(output).toContain('Blocking');
    expect(output).toContain('Optional');
  });

  it('re-run hint printed when blocking failures exist', async () => {
    const { out, write } = capture();
    await runReadiness({
      write,
      _dbCheck: async () => DB_NOT_REACHABLE,
      _axonVersion: async () => null,
      _loadConfig: async () => { throw new Error('no config'); },
    });
    expect(lines(out)).toContain('Re-run');
  });
});
