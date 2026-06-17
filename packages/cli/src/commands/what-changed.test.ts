/**
 * HOR-207 — `horus what-changed --ai` tests.
 *
 * Tests cover:
 * - The AI contract string is present and describes the required output sections
 * - The prompt shape carries the WhatChangedReport as evidence with grounding rules
 * - Provider unavailable / error behaviors (via renderAiInterpretation — already in
 *   ai-provider.test.ts; here we verify the command-specific prompt content)
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { WHAT_CHANGED_AI_CONTRACT } from './what-changed.js';

const SAMPLE_REPORT = {
  window: { since: '6 hours ago', until: null, service: 'api' },
  commitCount: 3,
  topCommits: [
    { shortSha: 'abc1234', dateIso: '2026-06-17T10:00:00Z', subject: 'fix: payment timeout' },
    { shortSha: 'def5678', dateIso: '2026-06-17T09:00:00Z', subject: 'feat: retry logic' },
  ],
  changeImpact: null,
  contributors: [{ author: 'alice', commits: 3 }],
  queueTopology: { touched: true, files: ['src/workers/payment.processor.ts'] },
  summary: '3 commit(s) touching api since 6 hours ago.',
  note: 'A change is evidence, not a conclusion.',
};

describe('WHAT_CHANGED_AI_CONTRACT', () => {
  it('describes the required output sections', () => {
    expect(WHAT_CHANGED_AI_CONTRACT).toContain('Evidence used');
    expect(WHAT_CHANGED_AI_CONTRACT).toContain('Interpretation');
    expect(WHAT_CHANGED_AI_CONTRACT).toContain('Confidence');
    expect(WHAT_CHANGED_AI_CONTRACT).toContain('Next checks');
  });

  it('is a non-empty string', () => {
    expect(typeof WHAT_CHANGED_AI_CONTRACT).toBe('string');
    expect(WHAT_CHANGED_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for what-changed (HOR-207)', () => {
  it('prompt contains the command name and promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'what-changed',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: WHAT_CHANGED_AI_CONTRACT,
    });

    expect(prompt).toContain('what-changed');
    expect(prompt).toContain('change-risk');
  });

  it('prompt serializes WhatChangedReport evidence — commit SHAs visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'what-changed',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: WHAT_CHANGED_AI_CONTRACT,
    });

    // Key fields from the report must appear in the prompt so the model sees real data
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('fix: payment timeout');
    expect(prompt).toContain('payment.processor.ts');
  });

  it('prompt includes grounding rules — model must not invent evidence', () => {
    const prompt = buildInterpretationPrompt({
      command: 'what-changed',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: WHAT_CHANGED_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (service) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'what-changed',
      userIntent: 'service: api',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: WHAT_CHANGED_AI_CONTRACT,
    });

    expect(prompt).toContain('service: api');
  });

  it('output contract sections appear in the prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'what-changed',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: WHAT_CHANGED_AI_CONTRACT,
    });

    expect(prompt).toContain('Evidence used');
    expect(prompt).toContain('Interpretation');
    expect(prompt).toContain('Confidence');
    expect(prompt).toContain('Next checks');
  });
});
