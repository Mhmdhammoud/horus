/**
 * HOR-213 — AI contract and prompt shape tests for `horus state --ai`.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { STATE_AI_CONTRACT } from './state.js';

const SAMPLE_ANALYSIS = {
  database: 'prod',
  autoDiscovered: true,
  collections: [
    {
      collection: 'orders',
      count: 15234,
      isStale: false,
      ageHours: 0.5,
      dateField: 'createdAt',
      anomalies: [],
    },
    {
      collection: 'jobs',
      count: 432,
      isStale: true,
      ageHours: 36.2,
      dateField: 'updatedAt',
      anomalies: [
        { value: 'failed', count: 89 },
        { value: 'stuck', count: 12 },
      ],
    },
    {
      collection: 'sessions',
      count: 8901,
      isStale: false,
      ageHours: 0.1,
      dateField: 'lastActiveAt',
      anomalies: [],
    },
  ],
};

describe('STATE_AI_CONTRACT (HOR-213)', () => {
  it('describes all required output sections', () => {
    expect(STATE_AI_CONTRACT).toContain('Evidence used');
    expect(STATE_AI_CONTRACT).toContain('What stands out');
    expect(STATE_AI_CONTRACT).toContain('What this may indicate');
    expect(STATE_AI_CONTRACT).toContain('What is not proven');
    expect(STATE_AI_CONTRACT).toContain('Next checks');
  });
});

describe('buildInterpretationPrompt for state (HOR-213)', () => {
  it('prompt serializes MongoDB analysis — collections, counts, anomalies visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'state',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: STATE_AI_CONTRACT,
    });

    expect(prompt).toContain('orders');
    expect(prompt).toContain('jobs');
    expect(prompt).toContain('failed');
    expect(prompt).toContain('stuck');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'state',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: STATE_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
    expect(prompt).toContain('Do not invent files');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'state',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: STATE_AI_CONTRACT,
    });

    expect(prompt).toContain('What is not proven');
    expect(prompt).toContain('What stands out');
  });

  it('staleness and anomaly count are part of evidence', () => {
    const prompt = buildInterpretationPrompt({
      command: 'state',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: STATE_AI_CONTRACT,
    });

    expect(prompt).toContain('36');
    expect(prompt).toContain('89');
  });
});
