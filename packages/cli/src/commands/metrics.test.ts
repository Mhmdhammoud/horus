/**
 * HOR-213 — AI contract and prompt shape tests for `horus metrics --ai`.
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { METRICS_AI_CONTRACT } from './metrics.js';

const SAMPLE_FINDINGS = [
  {
    panelTitle: 'API Latency (p95)',
    anomaly: 'latency-spike',
    baselineAvg: 0.12,
    currentAvg: 0.85,
    ratio: 7.08,
    labels: { service: 'api', env: 'production' },
    matchSource: 'panel-title',
  },
  {
    panelTitle: 'HTTP Error Rate',
    anomaly: 'error-rate-change',
    baselineAvg: 0.002,
    currentAvg: 0.031,
    ratio: 15.5,
    labels: { service: 'api' },
    matchSource: 'panel-title',
  },
  {
    panelTitle: 'Job Queue Depth',
    anomaly: 'none',
    baselineAvg: 12,
    currentAvg: 14,
    ratio: 1.17,
    labels: { queue: 'payments' },
    matchSource: 'panel-title',
  },
];

describe('METRICS_AI_CONTRACT (HOR-213)', () => {
  it('describes all required output sections', () => {
    expect(METRICS_AI_CONTRACT).toContain('Evidence used');
    expect(METRICS_AI_CONTRACT).toContain('What stands out');
    expect(METRICS_AI_CONTRACT).toContain('What this may indicate');
    expect(METRICS_AI_CONTRACT).toContain('What is not proven');
    expect(METRICS_AI_CONTRACT).toContain('Next checks');
  });
});

describe('buildInterpretationPrompt for metrics (HOR-213)', () => {
  it('prompt serializes metric findings — panel names, anomaly types, and ratios visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'metrics',
      evidence: SAMPLE_FINDINGS,
      promptKind: 'evidence-summary',
      outputContract: METRICS_AI_CONTRACT,
    });

    expect(prompt).toContain('API Latency');
    expect(prompt).toContain('HTTP Error Rate');
    expect(prompt).toContain('latency-spike');
    expect(prompt).toContain('error-rate-change');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'metrics',
      evidence: SAMPLE_FINDINGS,
      promptKind: 'evidence-summary',
      outputContract: METRICS_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
    expect(prompt).toContain('Do not invent files');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'metrics',
      evidence: SAMPLE_FINDINGS,
      promptKind: 'evidence-summary',
      outputContract: METRICS_AI_CONTRACT,
    });

    expect(prompt).toContain('What is not proven');
    expect(prompt).toContain('What this may indicate');
  });

  it('hint carries through as userIntent when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'metrics',
      userIntent: 'hint: payment',
      evidence: SAMPLE_FINDINGS,
      promptKind: 'evidence-summary',
      outputContract: METRICS_AI_CONTRACT,
    });

    expect(prompt).toContain('hint: payment');
  });
});
