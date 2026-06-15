/**
 * HOR-113 — Smoke tests for the AI narrative path using the fake provider.
 *
 * Exercises renderNarrative end-to-end with a deterministic fake provider so
 * the AI narrative path has CI coverage without any API credentials or network
 * calls. Covers: full happy path, fallback on invalid output, deterministic
 * fallback invariants.
 */

import { describe, it, expect } from 'vitest';
import { renderNarrative, validateNarrative } from './contract.js';
import {
  FIXTURE_INPUT,
  FIXTURE_VALID_OUTPUT,
  FIXTURE_UNKNOWN_CITATION,
  FIXTURE_CONFIDENCE_INFLATION,
  FIXTURE_HALLUCINATED_SERVICE,
} from './fixtures.js';
import { createFakeNarrativeProvider } from './fake-provider.js';

// ---------------------------------------------------------------------------
// 1. Happy path — fake provider returns a valid output
// ---------------------------------------------------------------------------

describe('fake provider — happy path', () => {
  it('createFakeNarrativeProvider produces a provider with name "fake"', () => {
    const provider = createFakeNarrativeProvider();
    expect(provider.name).toBe('fake');
  });

  it('renderNarrative with fake provider returns fromProvider:true', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(result.fromProvider).toBe(true);
  });

  it('no validationErrors when fake provider output is valid', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(result.validationErrors).toBeUndefined();
  });

  it('output.what is a non-empty string', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(result.output.what.length).toBeGreaterThan(0);
  });

  it('output.why is a non-empty string', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(result.output.why.length).toBeGreaterThan(0);
  });

  it('output.whereNext is a non-empty array', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(Array.isArray(result.output.whereNext)).toBe(true);
    expect(result.output.whereNext.length).toBeGreaterThan(0);
  });

  it('output.confidence does not exceed reportConfidence', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_VALID_OUTPUT),
    });
    expect(result.output.confidence).toBeLessThanOrEqual(FIXTURE_INPUT.reportConfidence + 0.001);
  });

  it('default output (no argument) passes validateNarrative', () => {
    const provider = createFakeNarrativeProvider();
    // render manually to inspect the output shape
    const output = provider.render(FIXTURE_INPUT);
    return output.then((out) => {
      const { valid } = validateNarrative(out, FIXTURE_INPUT);
      expect(valid).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Fallback path — fake provider returns known-invalid fixture outputs
// ---------------------------------------------------------------------------

describe('fake provider — fallback on invalid output', () => {
  it('falls back when fake returns unknown citation (FIXTURE_UNKNOWN_CITATION)', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_UNKNOWN_CITATION),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.some((e) => e.includes('hallucinated citation'))).toBe(true);
  });

  it('falls back when fake inflates confidence (FIXTURE_CONFIDENCE_INFLATION)', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_CONFIDENCE_INFLATION),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('falls back when fake hallucinated a service (FIXTURE_HALLUCINATED_SERVICE)', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_HALLUCINATED_SERVICE),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.some((e) => e.includes('hallucination'))).toBe(true);
  });

  it('fallback output is always a usable narrative even when provider is invalid', async () => {
    const result = await renderNarrative(FIXTURE_INPUT, {
      provider: createFakeNarrativeProvider(FIXTURE_UNKNOWN_CITATION),
    });
    // Deterministic fallback must populate all required fields
    expect(result.output.what.length).toBeGreaterThan(0);
    expect(result.output.why.length).toBeGreaterThan(0);
    expect(result.output.whereNext.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Deterministic fallback is unaffected by AI path
// ---------------------------------------------------------------------------

describe('deterministic fallback — invariants', () => {
  it('no provider → fromProvider:false and deterministic what', async () => {
    const result = await renderNarrative(FIXTURE_INPUT);
    expect(result.fromProvider).toBe(false);
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('provider failure → fromProvider:false and valid deterministic narrative', async () => {
    const throwingProvider = {
      name: 'broken',
      async render(): Promise<never> {
        throw new Error('no API key');
      },
    };
    const result = await renderNarrative(FIXTURE_INPUT, { provider: throwingProvider });
    expect(result.fromProvider).toBe(false);
    expect(result.output.what).toBe(FIXTURE_INPUT.deterministicSummary);
  });

  it('deterministic output confidence equals reportConfidence', async () => {
    const result = await renderNarrative(FIXTURE_INPUT);
    expect(result.output.confidence).toBe(FIXTURE_INPUT.reportConfidence);
  });

  it('deterministic why references the top suspected cause', async () => {
    const result = await renderNarrative(FIXTURE_INPUT);
    expect(result.output.why).toContain(FIXTURE_INPUT.suspectedCauses[0]!.label);
  });
});
