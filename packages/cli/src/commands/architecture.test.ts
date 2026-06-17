/**
 * HOR-210 — `horus architecture --ai` tests.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { ARCHITECTURE_AI_CONTRACT } from './architecture.js';

const SAMPLE_MODEL = {
  nodeStats: [{ label: 'Function', count: 142 }, { label: 'Class', count: 38 }],
  subsystems: [
    { name: 'payments', members: 24 },
    { name: 'zoho', members: 18 },
  ],
  asyncBoundaries: [
    { queueName: 'payment-retry-queue', producers: ['PaymentService'], workers: ['PaymentRetryWorker'] },
  ],
  keyFlows: ['PaymentController → PaymentService → payment-retry-queue → PaymentRetryWorker'],
  externalSystems: [
    { name: 'zoho', files: 9 },
    { name: 'stripe', files: 5 },
  ],
  fragile: { deadCode: 3, highCouplingPairs: 7 },
  summary: '2 subsystems, 1 async boundary, 2 external systems discovered.',
};

describe('ARCHITECTURE_AI_CONTRACT (HOR-210)', () => {
  it('describes all required output sections', () => {
    expect(ARCHITECTURE_AI_CONTRACT).toContain('System summary');
    expect(ARCHITECTURE_AI_CONTRACT).toContain('Critical paths');
    expect(ARCHITECTURE_AI_CONTRACT).toContain('Fragility / risk points');
    expect(ARCHITECTURE_AI_CONTRACT).toContain('How to investigate this system');
    expect(ARCHITECTURE_AI_CONTRACT).toContain('Confidence / gaps');
  });

  it('is a non-empty string', () => {
    expect(typeof ARCHITECTURE_AI_CONTRACT).toBe('string');
    expect(ARCHITECTURE_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for architecture (HOR-210)', () => {
  it('prompt contains the command name and system-explanation promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'architecture',
      evidence: SAMPLE_MODEL,
      promptKind: 'system-explanation',
      outputContract: ARCHITECTURE_AI_CONTRACT,
    });

    expect(prompt).toContain('architecture');
    expect(prompt).toContain('system-explanation');
  });

  it('prompt serializes ArchitectureModel — subsystems, queue, and external systems visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'architecture',
      evidence: SAMPLE_MODEL,
      promptKind: 'system-explanation',
      outputContract: ARCHITECTURE_AI_CONTRACT,
    });

    expect(prompt).toContain('payments');
    expect(prompt).toContain('payment-retry-queue');
    expect(prompt).toContain('PaymentRetryWorker');
    expect(prompt).toContain('zoho');
    expect(prompt).toContain('stripe');
  });

  it('prompt includes grounding rules — model must not invent components', () => {
    const prompt = buildInterpretationPrompt({
      command: 'architecture',
      evidence: SAMPLE_MODEL,
      promptKind: 'system-explanation',
      outputContract: ARCHITECTURE_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'architecture',
      evidence: SAMPLE_MODEL,
      promptKind: 'system-explanation',
      outputContract: ARCHITECTURE_AI_CONTRACT,
    });

    expect(prompt).toContain('System summary');
    expect(prompt).toContain('Fragility / risk points');
    expect(prompt).toContain('Confidence / gaps');
  });
});
