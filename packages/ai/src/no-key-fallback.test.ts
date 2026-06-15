/**
 * HOR-114 — No-key deterministic fallback tests.
 *
 * Documents and guards the behaviour when --ai is used but no provider
 * credentials are configured. The investigation must never fail:
 *
 *   1. Missing or empty ANTHROPIC_API_KEY → provider throws / returns 401.
 *   2. renderNarrative catches the error → fromProvider:false.
 *   3. Deterministic summary is returned as output.what (shown above the warning).
 *   4. validationErrors contains the signal the CLI uses to print its note.
 *
 * The user-visible CLI message is:
 *   "[ai] Provider unavailable — deterministic output shown above."
 *   (printed in investigate.ts when fromProvider is false)
 *
 * All tests are offline — no live API calls, no credentials required.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AnthropicNarrativeProvider } from './anthropic.js';
import { renderNarrative } from './contract.js';
import { FIXTURE_INPUT } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mock401(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    } as Response),
  );
}

function mockNetworkError(): void {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 1. No env var — ANTHROPIC_API_KEY not set
// ---------------------------------------------------------------------------

describe('no-key fallback — missing ANTHROPIC_API_KEY env var', () => {
  beforeEach(() => {
    // Ensure the env var is absent for these tests
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('provider construction does not throw when key is absent', () => {
    expect(() => new AnthropicNarrativeProvider()).not.toThrow();
  });

  it('renderNarrative returns fromProvider:false when 401 (no key)', async () => {
    mock401();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider(),
    });
    expect(result.fromProvider).toBe(false);
  });

  it('deterministic output is returned and complete (what, why, whereNext)', async () => {
    mock401();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider(),
    });
    expect(result.output.what.length).toBeGreaterThan(0);
    expect(result.output.why.length).toBeGreaterThan(0);
    expect(result.output.whereNext.length).toBeGreaterThan(0);
  });

  it('output.what matches the deterministic summary (shown above the warning)', async () => {
    mock401();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider(),
    });
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('validationErrors is defined — CLI uses this to print the secondary note', async () => {
    mock401();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider(),
    });
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit empty key (apiKey: '')
// ---------------------------------------------------------------------------

describe('no-key fallback — explicit empty apiKey', () => {
  it('renderNarrative returns fromProvider:false on 401 with empty key', async () => {
    mock401();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: '' }),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });
});

// ---------------------------------------------------------------------------
// 3. Network failure (ECONNREFUSED, DNS failure, etc.)
// ---------------------------------------------------------------------------

describe('no-key fallback — network failure', () => {
  it('renderNarrative returns fromProvider:false on network error', async () => {
    mockNetworkError();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'any-key' }),
    });
    expect(result.fromProvider).toBe(false);
  });

  it('deterministic output is complete on network failure', async () => {
    mockNetworkError();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'any-key' }),
    });
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
    expect(result.output.why).toContain(FIXTURE_INPUT.suspectedCauses[0]!.label);
  });

  it('validationErrors contains "Provider threw an error" (CLI secondary note trigger)', async () => {
    mockNetworkError();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'any-key' }),
    });
    expect(result.validationErrors).toContain('Provider threw an error');
  });
});

// ---------------------------------------------------------------------------
// 4. Provider timeout simulation (mocked slow fetch)
// ---------------------------------------------------------------------------

describe('no-key fallback — provider timeout / error', () => {
  it('renderNarrative falls back when provider rejects with timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('AbortError: The operation was aborted')),
    );
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'k' }),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('confidence in fallback output equals reportConfidence (never drops)', async () => {
    mockNetworkError();
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'k' }),
    });
    expect(result.output.confidence).toBe(FIXTURE_INPUT.reportConfidence);
  });
});
