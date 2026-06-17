/**
 * HOR-212 — `horus score --ai` tests.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { SCORE_AI_CONTRACT } from './score.js';

const SAMPLE_SCORE = {
  score: 42,
  grade: 'D',
  components: [
    { dimension: 'Evidence support', value: 0.5, weight: 0.3, note: '4 evidence items — moderate' },
    { dimension: 'Hypothesis discrimination', value: 0.25, weight: 0.25, note: '1/4 hypotheses resolved' },
    { dimension: 'Cause confidence', value: 0.6, weight: 0.2, note: 'top cause at 60% confidence' },
    { dimension: 'Coverage breadth', value: 0.2, weight: 0.15, note: 'only source evidence collected' },
    { dimension: 'Findings richness', value: 0.3, weight: 0.1, note: '2 findings' },
  ],
  summary: 'Score 42/100 (D) — low coverage and unresolved hypotheses.',
};

describe('SCORE_AI_CONTRACT (HOR-212)', () => {
  it('describes all required output sections', () => {
    expect(SCORE_AI_CONTRACT).toContain('Why this scored this way');
    expect(SCORE_AI_CONTRACT).toContain('Biggest improvement lever');
    expect(SCORE_AI_CONTRACT).toContain('Suggested improvements');
  });

  it('is a non-empty string', () => {
    expect(typeof SCORE_AI_CONTRACT).toBe('string');
    expect(SCORE_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for score (HOR-212)', () => {
  it('prompt contains the command name and evidence-summary promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'score',
      userIntent: 'investigation: inv-abc123',
      evidence: SAMPLE_SCORE,
      promptKind: 'evidence-summary',
      outputContract: SCORE_AI_CONTRACT,
    });

    expect(prompt).toContain('score');
    expect(prompt).toContain('evidence-summary');
  });

  it('prompt serializes QualityScore — grade, dimensions, and notes visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'score',
      userIntent: 'investigation: inv-abc123',
      evidence: SAMPLE_SCORE,
      promptKind: 'evidence-summary',
      outputContract: SCORE_AI_CONTRACT,
    });

    expect(prompt).toContain('Evidence support');
    expect(prompt).toContain('Hypothesis discrimination');
    expect(prompt).toContain('only source evidence collected');
    expect(prompt).toContain('42');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'score',
      evidence: SAMPLE_SCORE,
      promptKind: 'evidence-summary',
      outputContract: SCORE_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (investigation id) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'score',
      userIntent: 'investigation: inv-abc123',
      evidence: SAMPLE_SCORE,
      promptKind: 'evidence-summary',
      outputContract: SCORE_AI_CONTRACT,
    });

    expect(prompt).toContain('investigation: inv-abc123');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'score',
      evidence: SAMPLE_SCORE,
      promptKind: 'evidence-summary',
      outputContract: SCORE_AI_CONTRACT,
    });

    expect(prompt).toContain('Biggest improvement lever');
    expect(prompt).toContain('Suggested improvements');
  });
});
