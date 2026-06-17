/**
 * HOR-210 — `horus onboard --ai` tests.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { ONBOARD_AI_CONTRACT } from './onboard.js';

const SAMPLE_GUIDE = {
  area: 'payments',
  architecture: {
    nodeStats: [{ label: 'Function', count: 24 }],
    subsystems: [{ name: 'payments', members: 24 }],
    asyncBoundaries: [
      { queueName: 'payment-retry-queue', producers: ['PaymentService'], workers: ['PaymentRetryWorker'] },
    ],
    keyFlows: ['PaymentController → PaymentService → payment-retry-queue → PaymentRetryWorker'],
    externalSystems: [{ name: 'stripe', files: 5 }],
    fragile: { deadCode: 1, highCouplingPairs: 2 },
    summary: '1 subsystem, 1 async boundary, 1 external system discovered.',
  },
  ownership: {
    bySubsystem: [{ subsystem: 'payments', authors: ['alice', 'bob'] }],
  },
  pastIncidents: [
    { id: 'inv-001', title: 'payment timeout spike', createdAt: '2026-06-01T00:00:00Z' },
  ],
  summary: 'Onboarding guide for payments area.',
};

describe('ONBOARD_AI_CONTRACT (HOR-210)', () => {
  it('describes all required output sections', () => {
    expect(ONBOARD_AI_CONTRACT).toContain('Start here');
    expect(ONBOARD_AI_CONTRACT).toContain('Mental model');
    expect(ONBOARD_AI_CONTRACT).toContain('What breaks here');
    expect(ONBOARD_AI_CONTRACT).toContain('Useful commands');
    expect(ONBOARD_AI_CONTRACT).toContain('Confidence / gaps');
  });

  it('is a non-empty string', () => {
    expect(typeof ONBOARD_AI_CONTRACT).toBe('string');
    expect(ONBOARD_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for onboard (HOR-210)', () => {
  it('prompt contains the command name and system-explanation promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'onboard',
      userIntent: 'area: payments',
      evidence: SAMPLE_GUIDE,
      promptKind: 'system-explanation',
      outputContract: ONBOARD_AI_CONTRACT,
    });

    expect(prompt).toContain('onboard');
    expect(prompt).toContain('system-explanation');
  });

  it('prompt serializes OnboardingGuide — async boundary, past incident, and ownership visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'onboard',
      userIntent: 'area: payments',
      evidence: SAMPLE_GUIDE,
      promptKind: 'system-explanation',
      outputContract: ONBOARD_AI_CONTRACT,
    });

    expect(prompt).toContain('payment-retry-queue');
    expect(prompt).toContain('payment timeout spike');
    expect(prompt).toContain('stripe');
  });

  it('prompt includes grounding rules — model must not invent components', () => {
    const prompt = buildInterpretationPrompt({
      command: 'onboard',
      evidence: SAMPLE_GUIDE,
      promptKind: 'system-explanation',
      outputContract: ONBOARD_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (area) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'onboard',
      userIntent: 'area: payments',
      evidence: SAMPLE_GUIDE,
      promptKind: 'system-explanation',
      outputContract: ONBOARD_AI_CONTRACT,
    });

    expect(prompt).toContain('area: payments');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'onboard',
      evidence: SAMPLE_GUIDE,
      promptKind: 'system-explanation',
      outputContract: ONBOARD_AI_CONTRACT,
    });

    expect(prompt).toContain('Mental model');
    expect(prompt).toContain('What breaks here');
    expect(prompt).toContain('Confidence / gaps');
  });
});
