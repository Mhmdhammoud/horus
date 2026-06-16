/**
 * Tests for the Horus source-intelligence boundary (HOR-136, HOR-142).
 *
 * Verifies that every Horus-named export delegates to or is structurally
 * identical to the Axon-compatible implementation. All tests are offline —
 * no network or binary is required.
 */
import { describe, it, expect, afterEach, expectTypeOf } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SourceHttpClient,
  SourceHttpError,
  SourceCodeProvider,
  sourceAvailable,
  getSourceVersion,
  readSourceHostUrl,
} from './source-boundary.js';
import type {
  SourceNode,
  SourceSearchResult,
  SourceCypherResult,
  SourceImpactResult,
  SourceDiffResult,
  SourceOverview,
  SourceHostInfo,
  SourceHealth,
} from './source-boundary.js';
import { AxonHttpClient } from './client.js';
import { AxonCodeProvider } from './provider.js';
import type {
  AxonNode,
  AxonSearchResult,
  AxonCypherResult,
  AxonImpactResult,
  AxonDiffResult,
  AxonOverview,
  AxonHostInfo,
  AxonHealth,
} from './types.js';

// ---------------------------------------------------------------------------
// Class alias tests
// ---------------------------------------------------------------------------

describe('source-boundary — class aliases (HOR-136)', () => {
  it('SourceHttpClient is the same constructor as AxonHttpClient', () => {
    expect(SourceHttpClient).toBe(AxonHttpClient);
  });

  it('SourceCodeProvider is the same constructor as AxonCodeProvider', () => {
    expect(SourceCodeProvider).toBe(AxonCodeProvider);
  });

  it('SourceHttpClient can be constructed with SourceClientOptions', () => {
    const client = new SourceHttpClient({ baseUrl: 'http://localhost:8420', timeoutMs: 3000 });
    expect(client).toBeDefined();
    expect(client).toBeInstanceOf(AxonHttpClient);
  });

  it('SourceHttpError is constructable with status and body', () => {
    const err = new SourceHttpError('request failed', 503, 'Service Unavailable');
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(503);
    expect(err.body).toBe('Service Unavailable');
    expect(err.message).toBe('request failed');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle delegate tests (offline — no axon binary required)
// ---------------------------------------------------------------------------

describe('source-boundary — lifecycle delegates (HOR-136)', () => {
  it('sourceAvailable returns a boolean (resolves even without axon binary)', async () => {
    const result = await sourceAvailable();
    expect(typeof result).toBe('boolean');
  });

  it('getSourceVersion returns string or null (resolves even without axon binary)', async () => {
    const result = await getSourceVersion();
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('readSourceHostUrl returns null for a non-existent root', () => {
    const result = readSourceHostUrl('/nonexistent/path/horus-test-xyz');
    expect(result).toBeNull();
  });

  describe('readSourceHostUrl — path resolution order (HOR-137)', () => {
    let tmp: string;

    afterEach(() => {
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('reads from .horus/source/host.json when present', () => {
      tmp = join(tmpdir(), `horus-test-${process.pid}`);
      mkdirSync(join(tmp, '.horus', 'source'), { recursive: true });
      writeFileSync(
        join(tmp, '.horus', 'source', 'host.json'),
        JSON.stringify({ host_url: 'http://127.0.0.1:9000' }),
      );
      expect(readSourceHostUrl(tmp)).toBe('http://127.0.0.1:9000');
    });

    it('returns null when .horus/source/host.json is absent', () => {
      tmp = join(tmpdir(), `horus-test-${process.pid}`);
      mkdirSync(tmp, { recursive: true });
      expect(readSourceHostUrl(tmp)).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Horus-named type alias tests (HOR-142)
// ---------------------------------------------------------------------------

describe('source-boundary — Horus type aliases (HOR-142)', () => {
  it('SourceHealth is exported and structurally identical to AxonHealth', () => {
    expectTypeOf<SourceHealth>().toMatchTypeOf<AxonHealth>();
    expectTypeOf<AxonHealth>().toMatchTypeOf<SourceHealth>();
    expect(true).toBe(true); // compile-time only — runtime guard
  });

  it('SourceNode is exported and structurally identical to AxonNode', () => {
    expectTypeOf<SourceNode>().toMatchTypeOf<AxonNode>();
    expectTypeOf<AxonNode>().toMatchTypeOf<SourceNode>();
    expect(true).toBe(true);
  });

  it('SourceSearchResult is exported and structurally identical to AxonSearchResult', () => {
    expectTypeOf<SourceSearchResult>().toMatchTypeOf<AxonSearchResult>();
    expectTypeOf<AxonSearchResult>().toMatchTypeOf<SourceSearchResult>();
    expect(true).toBe(true);
  });

  it('SourceCypherResult is exported and structurally identical to AxonCypherResult', () => {
    expectTypeOf<SourceCypherResult>().toMatchTypeOf<AxonCypherResult>();
    expectTypeOf<AxonCypherResult>().toMatchTypeOf<SourceCypherResult>();
    expect(true).toBe(true);
  });

  it('SourceImpactResult is exported and structurally identical to AxonImpactResult', () => {
    expectTypeOf<SourceImpactResult>().toMatchTypeOf<AxonImpactResult>();
    expectTypeOf<AxonImpactResult>().toMatchTypeOf<SourceImpactResult>();
    expect(true).toBe(true);
  });

  it('SourceDiffResult is exported and structurally identical to AxonDiffResult', () => {
    expectTypeOf<SourceDiffResult>().toMatchTypeOf<AxonDiffResult>();
    expectTypeOf<AxonDiffResult>().toMatchTypeOf<SourceDiffResult>();
    expect(true).toBe(true);
  });

  it('SourceOverview is exported and structurally identical to AxonOverview', () => {
    expectTypeOf<SourceOverview>().toMatchTypeOf<AxonOverview>();
    expectTypeOf<AxonOverview>().toMatchTypeOf<SourceOverview>();
    expect(true).toBe(true);
  });

  it('SourceHostInfo is exported and structurally identical to AxonHostInfo', () => {
    expectTypeOf<SourceHostInfo>().toMatchTypeOf<AxonHostInfo>();
    expectTypeOf<AxonHostInfo>().toMatchTypeOf<SourceHostInfo>();
    expect(true).toBe(true);
  });
});
