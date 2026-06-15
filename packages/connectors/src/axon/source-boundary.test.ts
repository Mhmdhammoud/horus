/**
 * Tests for the Horus source-intelligence boundary (HOR-136).
 *
 * Verifies that every Horus-named export delegates to or is structurally
 * identical to the Axon-compatible implementation. All tests are offline —
 * no network or binary is required.
 */
import { describe, it, expect } from 'vitest';
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
});
