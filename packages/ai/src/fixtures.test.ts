/**
 * HOR-60 — Tests that exercise each narrative fixture against validateNarrative.
 * All tests are offline and deterministic.
 */

import { describe, it, expect } from 'vitest';
import { validateNarrative } from './contract.js';
import {
  FIXTURE_INPUT,
  FIXTURE_VALID_OUTPUT,
  FIXTURE_UNKNOWN_CITATION,
  FIXTURE_CONFIDENCE_INFLATION,
  FIXTURE_HALLUCINATED_SERVICE,
} from './fixtures.js';

describe('FIXTURE_VALID_OUTPUT', () => {
  it('passes validation against FIXTURE_INPUT', () => {
    const result = validateNarrative(FIXTURE_VALID_OUTPUT, FIXTURE_INPUT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('has all required sections populated', () => {
    expect(FIXTURE_VALID_OUTPUT.what.trim().length).toBeGreaterThan(0);
    expect(FIXTURE_VALID_OUTPUT.why.trim().length).toBeGreaterThan(0);
    expect(FIXTURE_VALID_OUTPUT.whereNext.length).toBeGreaterThan(0);
  });

  it('cites only evidence IDs present in FIXTURE_INPUT', () => {
    const knownIds = new Set(FIXTURE_INPUT.evidence.map((e) => e.id));
    for (const citation of FIXTURE_VALID_OUTPUT.citations) {
      expect(knownIds.has(citation.evidenceId)).toBe(true);
    }
  });

  it('confidence does not exceed FIXTURE_INPUT ceiling', () => {
    expect(FIXTURE_VALID_OUTPUT.confidence).toBeLessThanOrEqual(FIXTURE_INPUT.reportConfidence);
  });
});

describe('FIXTURE_UNKNOWN_CITATION', () => {
  it('fails validation with a hallucinated-citation error', () => {
    const result = validateNarrative(FIXTURE_UNKNOWN_CITATION, FIXTURE_INPUT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hallucinated citation'))).toBe(true);
  });

  it('error message identifies the unknown ID', () => {
    const result = validateNarrative(FIXTURE_UNKNOWN_CITATION, FIXTURE_INPUT);
    expect(result.errors.some((e) => e.includes('ev-DOES-NOT-EXIST'))).toBe(true);
  });
});

describe('FIXTURE_CONFIDENCE_INFLATION', () => {
  it('fails validation because confidence exceeds the ceiling', () => {
    const result = validateNarrative(FIXTURE_CONFIDENCE_INFLATION, FIXTURE_INPUT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('fixture confidence is higher than FIXTURE_INPUT ceiling', () => {
    expect(FIXTURE_CONFIDENCE_INFLATION.confidence).toBeGreaterThan(
      FIXTURE_INPUT.reportConfidence + 0.001,
    );
  });
});

describe('FIXTURE_HALLUCINATED_SERVICE', () => {
  it('fails validation because of an unknown service in mentionedServices', () => {
    const result = validateNarrative(FIXTURE_HALLUCINATED_SERVICE, FIXTURE_INPUT);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('hallucination'))).toBe(true);
  });

  it('error message names the invented service', () => {
    const result = validateNarrative(FIXTURE_HALLUCINATED_SERVICE, FIXTURE_INPUT);
    expect(result.errors.some((e) => e.includes('invented-service-xyz'))).toBe(true);
  });
});
