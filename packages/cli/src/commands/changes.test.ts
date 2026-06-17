/**
 * HOR-212 — `horus changes --ai` tests.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { CHANGES_AI_CONTRACT } from './changes.js';

const SAMPLE_REPORT = {
  base: 'HEAD~5',
  compare: 'HEAD',
  added: [
    { id: 'sym:services:PaymentService.retryWithBackoff', name: 'retryWithBackoff', filePath: 'src/services/payment.service.ts' },
  ],
  removed: [],
  modified: [
    {
      before: { id: 'sym:services:PaymentService.charge', name: 'charge', filePath: 'src/services/payment.service.ts' },
      after: { id: 'sym:services:PaymentService.charge', name: 'charge', filePath: 'src/services/payment.service.ts' },
    },
  ],
  affectedFlows: [
    { flowId: 'flow:checkout', flowName: 'Checkout', changedSymbols: ['charge'] },
  ],
  summary: '1 added, 0 removed, 1 modified. 1 flow(s) affected.',
};

describe('CHANGES_AI_CONTRACT (HOR-212)', () => {
  it('describes all required output sections', () => {
    expect(CHANGES_AI_CONTRACT).toContain('Highest-risk changes');
    expect(CHANGES_AI_CONTRACT).toContain('Review focus');
    expect(CHANGES_AI_CONTRACT).toContain('Testing suggestions');
    expect(CHANGES_AI_CONTRACT).toContain('Confidence / gaps');
  });

  it('is a non-empty string', () => {
    expect(typeof CHANGES_AI_CONTRACT).toBe('string');
    expect(CHANGES_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for changes (HOR-212)', () => {
  it('prompt contains the command name and change-risk promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'changes',
      userIntent: 'base: HEAD~5, compare: HEAD',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: CHANGES_AI_CONTRACT,
    });

    expect(prompt).toContain('changes');
    expect(prompt).toContain('change-risk');
  });

  it('prompt serializes ChangeImpactReport — added symbol, flow, and modified symbol visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'changes',
      userIntent: 'base: HEAD~5, compare: HEAD',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: CHANGES_AI_CONTRACT,
    });

    expect(prompt).toContain('retryWithBackoff');
    expect(prompt).toContain('charge');
    expect(prompt).toContain('Checkout');
    expect(prompt).toContain('payment.service.ts');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'changes',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: CHANGES_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (base/compare refs) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'changes',
      userIntent: 'base: HEAD~5, compare: HEAD',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: CHANGES_AI_CONTRACT,
    });

    expect(prompt).toContain('base: HEAD~5, compare: HEAD');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'changes',
      evidence: SAMPLE_REPORT,
      promptKind: 'change-risk',
      outputContract: CHANGES_AI_CONTRACT,
    });

    expect(prompt).toContain('Highest-risk changes');
    expect(prompt).toContain('Testing suggestions');
    expect(prompt).toContain('affected flows');
  });
});
