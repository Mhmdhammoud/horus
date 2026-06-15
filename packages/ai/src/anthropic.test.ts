/**
 * HOR-61 — Anthropic narrative provider adapter tests.
 * All tests are offline: global fetch is mocked with vi.stubGlobal.
 * No live Anthropic calls, no API keys required.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicNarrativeProvider } from './anthropic.js';
import { renderNarrative } from './contract.js';
import { FIXTURE_INPUT } from './fixtures.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: async () => body,
  } as unknown as Response;
}

/** Build a synthetic Anthropic API response containing a JSON narrative. */
function makeApiResponse(narrative: Record<string, unknown>): { content: { type: string; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(narrative) }] };
}

const VALID_NARRATIVE = {
  what: 'BullMQ workers stalled in leadcall-api after the concurrency bump.',
  why: 'Raising worker concurrency exhausted the Redis connection pool.',
  whereNext: ['Roll back concurrency to 2', 'Increase Redis max connections'],
  citations: [
    { evidenceId: 'ev-log-001', rationale: 'Direct stall evidence' },
    { evidenceId: 'ev-commit-001', rationale: 'Config change that triggered the issue' },
  ],
  confidence: 0.65,
  mentionedServices: ['leadcall-api'],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Constructor / configuration
// ---------------------------------------------------------------------------

describe('AnthropicNarrativeProvider — configuration', () => {
  it('exposes name "anthropic"', () => {
    const p = new AnthropicNarrativeProvider({ apiKey: 'k' });
    expect(p.name).toBe('anthropic');
  });

  it('sends default model claude-opus-4-8 when none specified', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(VALID_NARRATIVE)));
    vi.stubGlobal('fetch', mockFetch);

    await new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('claude-opus-4-8');
  });

  it('sends a custom model when specified', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(VALID_NARRATIVE)));
    vi.stubGlobal('fetch', mockFetch);

    await new AnthropicNarrativeProvider({ apiKey: 'k', model: 'claude-haiku-4-5' }).render(FIXTURE_INPUT);

    const body = JSON.parse(mockFetch.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe('claude-haiku-4-5');
  });

  it('uses ANTHROPIC_API_KEY env var when no apiKey option is given', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'env-key';
    const mockFetch = vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(VALID_NARRATIVE)));
    vi.stubGlobal('fetch', mockFetch);

    try {
      await new AnthropicNarrativeProvider().render(FIXTURE_INPUT);
      const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('env-key');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });
});

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

describe('AnthropicNarrativeProvider — success', () => {
  it('returns a NarrativeOutput with correct fields on a valid API response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(VALID_NARRATIVE))));

    const output = await new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT);

    expect(output.what).toBe(VALID_NARRATIVE.what);
    expect(output.why).toBe(VALID_NARRATIVE.why);
    expect(output.whereNext).toEqual(VALID_NARRATIVE.whereNext);
    expect(output.citations).toHaveLength(2);
    expect(output.citations[0]?.evidenceId).toBe('ev-log-001');
    expect(output.confidence).toBe(0.65);
    expect(output.mentionedServices).toEqual(['leadcall-api']);
  });

  it('clamps confidence to the input ceiling when the model returns a higher value', async () => {
    const inflated = { ...VALID_NARRATIVE, confidence: 0.99 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(inflated))));

    const output = await new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT);
    expect(output.confidence).toBeLessThanOrEqual(FIXTURE_INPUT.reportConfidence);
  });

  it('clamps confidence to a custom ceiling supplied via NarrativeProviderOptions', async () => {
    const inflated = { ...VALID_NARRATIVE, confidence: 0.9 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(inflated))));

    const output = await new AnthropicNarrativeProvider({ apiKey: 'k' }).render(
      FIXTURE_INPUT,
      { confidenceCeiling: 0.5 },
    );
    expect(output.confidence).toBeLessThanOrEqual(0.5);
  });

  it('parses a narrative wrapped in markdown code fences', async () => {
    const fenced = { content: [{ type: 'text', text: '```json\n' + JSON.stringify(VALID_NARRATIVE) + '\n```' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(fenced)));

    const output = await new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT);
    expect(output.what).toBe(VALID_NARRATIVE.what);
  });
});

// ---------------------------------------------------------------------------
// Failure paths (provider throws; renderNarrative falls back)
// ---------------------------------------------------------------------------

describe('AnthropicNarrativeProvider — failure', () => {
  it('throws on a non-OK API response (e.g. 401)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse({}, false, 401)));

    await expect(
      new AnthropicNarrativeProvider({ apiKey: 'bad' }).render(FIXTURE_INPUT),
    ).rejects.toThrow('Anthropic API error: 401');
  });

  it('throws when the response text contains no JSON object', async () => {
    const noJson = { content: [{ type: 'text', text: 'I cannot help with that.' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(noJson)));

    await expect(
      new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT),
    ).rejects.toThrow('did not contain a JSON object');
  });

  it('throws when fetch itself rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')));

    await expect(
      new AnthropicNarrativeProvider({ apiKey: 'k' }).render(FIXTURE_INPUT),
    ).rejects.toThrow('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// Integration with renderNarrative fallback
// ---------------------------------------------------------------------------

describe('renderNarrative + AnthropicNarrativeProvider', () => {
  it('returns fromProvider: true when provider output passes validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(VALID_NARRATIVE))));

    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'k' }),
    });

    expect(result.fromProvider).toBe(true);
    expect(result.output.what).toBe(VALID_NARRATIVE.what);
    expect(result.validationErrors).toBeUndefined();
  });

  it('falls back to deterministic output when provider throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('Network error')));

    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'k' }),
    });

    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toContain('Provider threw an error');
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('falls back when provider output cites an unknown evidence ID', async () => {
    const hallucinated = {
      ...VALID_NARRATIVE,
      citations: [{ evidenceId: 'ev-HALLUCINATED', rationale: 'invented' }],
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse(makeApiResponse(hallucinated))));

    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: 'k' }),
    });

    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors?.some((e) => e.includes('hallucinated citation'))).toBe(true);
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('investigation report is not blocked when API key is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(makeResponse({}, false, 401)));

    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: new AnthropicNarrativeProvider({ apiKey: '' }),
    });

    expect(result.fromProvider).toBe(false);
    expect(result.output).toBeDefined();
    expect(typeof result.output.what).toBe('string');
  });
});
