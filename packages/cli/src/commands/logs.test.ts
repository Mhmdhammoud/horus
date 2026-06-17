/**
 * HOR-209 — `horus logs --raw` defaults to error+ (matching the summary), with
 * --level override and --all-levels escape hatch.
 *
 * HOR-213 — AI contract and prompt shape tests for `horus logs --ai`.
 */
import { describe, it, expect } from 'vitest';
import { resolveRawLevel, LOGS_AI_CONTRACT } from './logs.js';
import { buildInterpretationPrompt } from '@horus/ai';

describe('resolveRawLevel', () => {
  it('defaults to error when neither --level nor --all-levels is set', () => {
    expect(resolveRawLevel({})).toBe('error');
  });

  it('honours an explicit --level', () => {
    expect(resolveRawLevel({ level: 'warn' })).toBe('warn');
    expect(resolveRawLevel({ level: 'fatal' })).toBe('fatal');
  });

  it('--all-levels removes the severity floor (all levels)', () => {
    expect(resolveRawLevel({ allLevels: true })).toBeUndefined();
  });

  it('--all-levels wins over --level', () => {
    expect(resolveRawLevel({ level: 'error', allLevels: true })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HOR-213 — AI contract and prompt shape tests
// ---------------------------------------------------------------------------

const SAMPLE_ANALYSIS = {
  totalErrors: 42,
  signatures: [
    { key: 'PAYMENT_TIMEOUT', count: 28, firstSeen: '2026-06-17T08:00:00Z', lastSeen: '2026-06-17T09:30:00Z', services: ['api', 'payment-worker'], isNew: true, ratio: 3.2 },
    { key: 'ZOHO_SYNC_FAIL', count: 14, firstSeen: '2026-06-17T08:10:00Z', lastSeen: '2026-06-17T09:00:00Z', services: ['zoho-worker'], isNew: false, ratio: 1.1 },
  ],
  newSignatures: [{ key: 'PAYMENT_TIMEOUT', count: 28 }],
  affectedServices: ['api', 'payment-worker', 'zoho-worker'],
};

describe('LOGS_AI_CONTRACT (HOR-213)', () => {
  it('describes all required output sections', () => {
    expect(LOGS_AI_CONTRACT).toContain('Evidence used');
    expect(LOGS_AI_CONTRACT).toContain('What stands out');
    expect(LOGS_AI_CONTRACT).toContain('What this may indicate');
    expect(LOGS_AI_CONTRACT).toContain('What is not proven');
    expect(LOGS_AI_CONTRACT).toContain('Next checks');
  });
});

describe('buildInterpretationPrompt for logs (HOR-213)', () => {
  it('prompt serializes error analysis — signatures, services, and new markers visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'logs',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: LOGS_AI_CONTRACT,
    });

    expect(prompt).toContain('PAYMENT_TIMEOUT');
    expect(prompt).toContain('ZOHO_SYNC_FAIL');
    expect(prompt).toContain('payment-worker');
    expect(prompt).toContain('42');
  });

  it('prompt includes grounding rules', () => {
    const prompt = buildInterpretationPrompt({
      command: 'logs',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: LOGS_AI_CONTRACT,
    });

    expect(prompt).toContain('Use only the evidence provided above');
    expect(prompt).toContain('Do not invent files');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'logs',
      evidence: SAMPLE_ANALYSIS,
      promptKind: 'evidence-summary',
      outputContract: LOGS_AI_CONTRACT,
    });

    expect(prompt).toContain('What is not proven');
    expect(prompt).toContain('What this may indicate');
  });
});
