/**
 * Tests for the Horus source-intelligence boundary (HOR-136).
 *
 * Verifies that every Horus-named export delegates to or is structurally
 * identical to the Axon-compatible implementation. All tests are offline —
 * no network or binary is required.
 */
import { describe, it, expect, afterEach } from 'vitest';
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
import { AxonHttpClient } from './client.js';
import { AxonCodeProvider } from './provider.js';

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

    it('falls back to .axon/host.json when .horus/source/host.json is absent', () => {
      tmp = join(tmpdir(), `horus-test-${process.pid}`);
      mkdirSync(join(tmp, '.axon'), { recursive: true });
      writeFileSync(
        join(tmp, '.axon', 'host.json'),
        JSON.stringify({ host_url: 'http://127.0.0.1:8420' }),
      );
      expect(readSourceHostUrl(tmp)).toBe('http://127.0.0.1:8420');
    });

    it('prefers .horus/source/host.json over .axon/host.json when both are present', () => {
      tmp = join(tmpdir(), `horus-test-${process.pid}`);
      mkdirSync(join(tmp, '.horus', 'source'), { recursive: true });
      mkdirSync(join(tmp, '.axon'), { recursive: true });
      writeFileSync(
        join(tmp, '.horus', 'source', 'host.json'),
        JSON.stringify({ host_url: 'http://127.0.0.1:9000' }),
      );
      writeFileSync(
        join(tmp, '.axon', 'host.json'),
        JSON.stringify({ host_url: 'http://127.0.0.1:8420' }),
      );
      expect(readSourceHostUrl(tmp)).toBe('http://127.0.0.1:9000');
    });
  });
});
