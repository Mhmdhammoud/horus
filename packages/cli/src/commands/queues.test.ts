/**
 * HOR-213 — AI contract and prompt shape tests for `horus queues --live --ai`.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { QUEUES_AI_CONTRACT } from './queues.js';

const SAMPLE_LIVE_EVIDENCE = {
  prefix: 'bull',
  collectedAt: '2026-06-17T09:00:00.000Z',
  queues: [
    {
      queueName: 'payment-processing',
      waiting: 312,
      active: 4,
      failed: 89,
      delayed: 12,
      paused: 0,
      isPaused: false,
      runtimeOnly: false,
      failedBreakdown: [{ reason: 'GATEWAY_TIMEOUT', count: 67 }],
    },
    {
      queueName: 'email-dispatch',
      waiting: 0,
      active: 1,
      failed: 0,
      delayed: 0,
      paused: 0,
      isPaused: true,
      runtimeOnly: false,
    },
    {
      queueName: 'legacy-sync',
      waiting: 5,
      active: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
      isPaused: false,
      runtimeOnly: true,
    },
  ],
};

describe('QUEUES_AI_CONTRACT (HOR-213)', () => {
  it('describes all required output sections', () => {
    expect(QUEUES_AI_CONTRACT).toContain('Evidence used');
    expect(QUEUES_AI_CONTRACT).toContain('What stands out');
    expect(QUEUES_AI_CONTRACT).toContain('What this may indicate');
    expect(QUEUES_AI_CONTRACT).toContain('What is not proven');
    expect(QUEUES_AI_CONTRACT).toContain('Next checks');
  });
});

describe('buildInterpretationPrompt for queues (HOR-213)', () => {
  it('prompt serializes live queue state — names, counts, and paused state visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('payment-processing');
    expect(prompt).toContain('email-dispatch');
    expect(prompt).toContain('GATEWAY_TIMEOUT');
    expect(prompt).toContain('312');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
    expect(prompt).toContain('Do not invent files');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('What is not proven');
    expect(prompt).toContain('What stands out');
  });

  it('runtime-only flag is part of the evidence', () => {
    const prompt = buildInterpretationPrompt({
      command: 'queues',
      evidence: SAMPLE_LIVE_EVIDENCE,
      promptKind: 'evidence-summary',
      outputContract: QUEUES_AI_CONTRACT,
    });

    expect(prompt).toContain('legacy-sync');
    expect(prompt).toContain('runtimeOnly');
  });
});
