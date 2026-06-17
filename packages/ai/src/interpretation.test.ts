/**
 * HOR-211 — tests for the shared command-level AI interpretation helper.
 *
 * Covers the four acceptance-criteria cases:
 *   - provider unavailable
 *   - provider error
 *   - successful interpretation
 *   - evidence-only grounding contract in the prompt
 */

import { describe, it, expect } from 'vitest';
import {
  INTERPRETATION_GROUNDING_RULES,
  buildInterpretationPrompt,
  generateInterpretation,
  renderInterpretation,
} from './interpretation.js';
import type { InterpretationProvider, InterpretationRequest } from './interpretation.js';

const REQUEST: InterpretationRequest = {
  command: 'what-changed',
  userIntent: 'why did checkout break?',
  evidence: { changes: [{ file: 'src/checkout.ts', commit: 'abc123' }], deploys: 1 },
  promptKind: 'change-risk',
  outputContract: 'Return a ranked list of risky changes with rationale.',
};

function fakeProvider(impl: (prompt: string) => Promise<string>): InterpretationProvider {
  return { name: 'fake', interpret: impl };
}

describe('buildInterpretationPrompt — evidence-only grounding contract', () => {
  it('embeds every grounding rule', () => {
    const prompt = buildInterpretationPrompt(REQUEST);
    for (const rule of INTERPRETATION_GROUNDING_RULES) {
      expect(prompt).toContain(rule);
    }
  });

  it('includes the command, user intent, evidence, and output contract', () => {
    const prompt = buildInterpretationPrompt(REQUEST);
    expect(prompt).toContain('`what-changed`');
    expect(prompt).toContain('why did checkout break?');
    expect(prompt).toContain('src/checkout.ts');
    expect(prompt).toContain('Return a ranked list of risky changes');
  });

  it('serializes structured evidence as JSON, not as a pre-rendered string', () => {
    const prompt = buildInterpretationPrompt(REQUEST);
    expect(prompt).toContain('"file": "src/checkout.ts"');
  });

  it('asks for confidence and concrete next checks', () => {
    const prompt = buildInterpretationPrompt(REQUEST);
    expect(prompt).toContain('Confidence:');
    expect(prompt).toContain('Next checks:');
  });
});

describe('generateInterpretation', () => {
  it('returns a graceful warning when no provider is configured (provider unavailable)', async () => {
    const result = await generateInterpretation(REQUEST, null);
    expect(result.ok).toBe(false);
    expect(result.text).toBeUndefined();
    expect(result.warning).toMatch(/connect ai|ANTHROPIC_API_KEY/i);
    expect(result.command).toBe('what-changed');
  });

  it('returns a graceful warning when the provider errors (provider error)', async () => {
    const provider = fakeProvider(async () => {
      throw new Error('boom: 500 upstream');
    });
    const result = await generateInterpretation(REQUEST, provider, { model: 'claude-opus-4-8' });
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('boom: 500 upstream');
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('treats an empty response as a graceful warning', async () => {
    const provider = fakeProvider(async () => '   ');
    const result = await generateInterpretation(REQUEST, provider);
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/empty/i);
  });

  it('returns the interpretation text on success', async () => {
    const provider = fakeProvider(async (prompt) => {
      // Provider sees the grounded prompt.
      expect(prompt).toContain('interpreting Horus evidence');
      return '  Highest risk: src/checkout.ts.\nConfidence: medium  ';
    });
    const result = await generateInterpretation(REQUEST, provider, { model: 'claude-opus-4-8' });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('Highest risk: src/checkout.ts.\nConfidence: medium');
    expect(result.provider).toBe('fake');
    expect(result.model).toBe('claude-opus-4-8');
  });

  it('never throws — provider rejection is caught', async () => {
    const provider = fakeProvider(() => Promise.reject('string failure'));
    await expect(generateInterpretation(REQUEST, provider)).resolves.toMatchObject({ ok: false });
  });
});

describe('renderInterpretation', () => {
  it('renders a labeled AI section on success', () => {
    const out = renderInterpretation({
      ok: true,
      command: 'what-changed',
      promptKind: 'change-risk',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      text: 'Interpretation body.',
    });
    expect(out).toContain('AI Interpretation');
    expect(out).toContain('anthropic, claude-opus-4-8');
    expect(out).toContain('Interpretation body.');
  });

  it('renders the warning when the result failed', () => {
    const out = renderInterpretation({
      ok: false,
      command: 'what-changed',
      promptKind: 'change-risk',
      warning: 'No AI provider configured.',
    });
    expect(out).toContain('AI Interpretation');
    expect(out).toContain('No AI provider configured.');
  });
});
