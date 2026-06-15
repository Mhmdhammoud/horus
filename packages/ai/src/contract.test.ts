/**
 * HOR-51 — Tests for the AI narrative contract, citation validator, and renderNarrative.
 * No live provider or network access required.
 */

import { describe, it, expect } from 'vitest';
import {
  validateNarrative,
  renderNarrative,
  type NarrativeInput,
  type NarrativeOutput,
  type NarrativeProvider,
} from './contract.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<NarrativeInput> = {}): NarrativeInput {
  return {
    investigationId: 'inv-001',
    hint: 'job processing timeout',
    reportConfidence: 0.7,
    evidence: [
      { id: 'ev-001', kind: 'log', title: 'Error: timeout after 5000ms', service: 'leadcall-api' },
      { id: 'ev-002', kind: 'metric', title: 'p99 latency spike', service: 'leadcall-api' },
      { id: 'ev-003', kind: 'commit', title: 'Bumped worker timeout to 5s' },
    ],
    knownServices: ['leadcall-api', 'zoho-sync'],
    suspectedCauses: [
      { label: 'Worker timeout too low', score: 0.85, evidenceIds: ['ev-001', 'ev-003'] },
    ],
    deterministicSummary: 'Job processing failed with timeout error in leadcall-api.',
    findings: [{ title: 'Timeout correlates with config change', evidenceIds: ['ev-003'] }],
    ...overrides,
  };
}

function makeOutput(overrides: Partial<NarrativeOutput> = {}): NarrativeOutput {
  return {
    what: 'The job worker timed out processing incoming jobs.',
    why: 'The timeout was recently reduced to 5s via a config change.',
    whereNext: ['Roll back the timeout config', 'Monitor queue depth'],
    citations: [{ evidenceId: 'ev-001' }, { evidenceId: 'ev-003' }],
    confidence: 0.65,
    ...overrides,
  };
}

// A fake provider that returns a valid output
function makeFakeProvider(outputOverride?: Partial<NarrativeOutput>): NarrativeProvider {
  return {
    name: 'fake',
    async render(input) {
      return makeOutput({
        confidence: input.reportConfidence * 0.9,
        ...outputOverride,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// validateNarrative
// ---------------------------------------------------------------------------

describe('validateNarrative', () => {
  it('valid output passes', () => {
    const result = validateNarrative(makeOutput(), makeInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects citation with unknown evidence ID', () => {
    const output = makeOutput({
      citations: [{ evidenceId: 'ev-HALLUCINATED' }],
    });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('ev-HALLUCINATED'))).toBe(true);
  });

  it('rejects confidence above reportConfidence', () => {
    const output = makeOutput({ confidence: 0.95 }); // input ceiling is 0.7
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('allows confidence equal to reportConfidence', () => {
    const output = makeOutput({ confidence: 0.7 });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(true);
  });

  it('rejects empty what section', () => {
    const output = makeOutput({ what: '' });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('what'))).toBe(true);
  });

  it('rejects empty why section', () => {
    const output = makeOutput({ why: '   ' });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('why'))).toBe(true);
  });

  it('rejects empty whereNext array', () => {
    const output = makeOutput({ whereNext: [] });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('whereNext'))).toBe(true);
  });

  it('rejects hallucinated service in mentionedServices', () => {
    const output = makeOutput({ mentionedServices: ['unknown-svc'] });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('unknown-svc'))).toBe(true);
  });

  it('accepts known service in mentionedServices (case-insensitive)', () => {
    const output = makeOutput({ mentionedServices: ['Leadcall-Api'] });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(true);
  });

  it('accumulates multiple errors', () => {
    const output = makeOutput({
      what: '',
      confidence: 0.99,
      citations: [{ evidenceId: 'ev-ghost' }],
    });
    const result = validateNarrative(output, makeInput());
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// renderNarrative — success path
// ---------------------------------------------------------------------------

describe('renderNarrative — success path', () => {
  it('returns fromProvider:true when provider output is valid', async () => {
    const input = makeInput();
    const result = await renderNarrative(input, { provider: makeFakeProvider() });
    expect(result.fromProvider).toBe(true);
    expect(result.output.what).toBeTruthy();
    expect(result.validationErrors).toBeUndefined();
  });

  it('provider output confidence is bounded by reportConfidence', async () => {
    const input = makeInput({ reportConfidence: 0.6 });
    const result = await renderNarrative(input, { provider: makeFakeProvider() });
    expect(result.output.confidence).toBeLessThanOrEqual(0.6 + 0.001);
  });
});

// ---------------------------------------------------------------------------
// renderNarrative — fallback on invalid output
// ---------------------------------------------------------------------------

describe('renderNarrative — fallback on invalid provider output', () => {
  it('falls back when provider returns unknown citation', async () => {
    const input = makeInput();
    const result = await renderNarrative(input, {
      provider: makeFakeProvider({ citations: [{ evidenceId: 'ev-ghost' }] }),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toBeDefined();
    expect(result.validationErrors!.some((e) => e.includes('ev-ghost'))).toBe(true);
    // Fallback narrative is still valid
    expect(result.output.what).toBeTruthy();
    expect(result.output.why).toBeTruthy();
  });

  it('falls back when provider inflates confidence', async () => {
    const input = makeInput({ reportConfidence: 0.5 });
    const result = await renderNarrative(input, {
      provider: makeFakeProvider({ confidence: 0.99 }),
    });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors!.some((e) => e.includes('confidence'))).toBe(true);
  });

  it('falls back when provider throws', async () => {
    const throwingProvider: NarrativeProvider = {
      name: 'broken',
      async render() {
        throw new Error('API unavailable');
      },
    };
    const input = makeInput();
    const result = await renderNarrative(input, { provider: throwingProvider });
    expect(result.fromProvider).toBe(false);
    expect(result.validationErrors).toBeDefined();
    // Deterministic fallback still returns a usable narrative
    expect(result.output.what).toBe(input.deterministicSummary);
  });
});

// ---------------------------------------------------------------------------
// renderNarrative — no provider (pure deterministic)
// ---------------------------------------------------------------------------

describe('renderNarrative — no provider', () => {
  it('returns fromProvider:false and a deterministic narrative', async () => {
    const input = makeInput();
    const result = await renderNarrative(input);
    expect(result.fromProvider).toBe(false);
    expect(result.output.what).toBe(input.deterministicSummary);
    expect(result.output.confidence).toBe(input.reportConfidence);
  });

  it('deterministic fallback uses top suspected cause in why', async () => {
    const input = makeInput();
    const result = await renderNarrative(input);
    expect(result.output.why).toContain(input.suspectedCauses[0]!.label);
  });

  it('deterministic fallback references first finding in whereNext', async () => {
    const input = makeInput();
    const result = await renderNarrative(input);
    expect(result.output.whereNext[0]).toContain(input.findings[0]!.title);
  });

  it('deterministic fallback with no causes produces generic why', async () => {
    const input = makeInput({ suspectedCauses: [] });
    const result = await renderNarrative(input);
    expect(result.output.why).toContain('could not be determined');
  });
});
