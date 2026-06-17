/**
 * HOR-202 — `horus timeline` defaults to a bounded recent window (parity with
 * `what-changed`) instead of all history.
 *
 * HOR-208 — `horus timeline --ai` appends a narrative interpretation.
 */
import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { resolveTimelineWindow, TIMELINE_AI_CONTRACT } from './timeline.js';

describe('resolveTimelineWindow', () => {
  it('defaults to the 7-day window when neither --since nor --all is given', () => {
    expect(resolveTimelineWindow({})).toEqual({ since: '7 days ago', usingDefault: true });
  });

  it('honours an explicit --since (no default hint)', () => {
    expect(resolveTimelineWindow({ since: '30 days ago' })).toEqual({
      since: '30 days ago',
      usingDefault: false,
    });
  });

  it('--all means no since bound (full history) and is not the default window', () => {
    expect(resolveTimelineWindow({ all: true })).toEqual({ since: undefined, usingDefault: false });
  });

  it('--all wins over --since (most permissive)', () => {
    expect(resolveTimelineWindow({ all: true, since: '30 days ago' })).toEqual({
      since: undefined,
      usingDefault: false,
    });
  });
});

// ---------------------------------------------------------------------------
// HOR-208 — AI contract and prompt shape tests
// ---------------------------------------------------------------------------

const SAMPLE_TIMELINE = {
  window: { since: '6 hours ago', until: null, service: 'api' },
  commits: [
    {
      sha: 'abc123def456abc123def456abc123def456abc1',
      shortSha: 'abc123d',
      dateIso: '2026-06-17T09:45:00Z',
      subject: 'fix: increase payment timeout to 30s',
      author: 'alice',
      files: ['src/payments/gateway.ts'],
    },
  ],
  changeImpact: null,
  summary: '1 commit(s) since 6 hours ago.',
  note: 'A change is evidence, not a conclusion.',
};

describe('TIMELINE_AI_CONTRACT (HOR-208)', () => {
  it('describes the required output sections', () => {
    expect(TIMELINE_AI_CONTRACT).toContain('Evidence used');
    expect(TIMELINE_AI_CONTRACT).toContain('Narrative');
    expect(TIMELINE_AI_CONTRACT).toContain('Confidence');
    expect(TIMELINE_AI_CONTRACT).toContain('Gaps / Next checks');
  });

  it('is a non-empty string', () => {
    expect(typeof TIMELINE_AI_CONTRACT).toBe('string');
    expect(TIMELINE_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for timeline (HOR-208)', () => {
  it('prompt contains the command name and timeline-narrative promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'timeline',
      evidence: SAMPLE_TIMELINE,
      promptKind: 'timeline-narrative',
      outputContract: TIMELINE_AI_CONTRACT,
    });

    expect(prompt).toContain('timeline');
    expect(prompt).toContain('timeline-narrative');
  });

  it('prompt serializes ChangeTimeline evidence — commit subjects visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'timeline',
      evidence: SAMPLE_TIMELINE,
      promptKind: 'timeline-narrative',
      outputContract: TIMELINE_AI_CONTRACT,
    });

    expect(prompt).toContain('abc123d');
    expect(prompt).toContain('fix: increase payment timeout to 30s');
    expect(prompt).toContain('gateway.ts');
  });

  it('prompt includes grounding rules — model must not invent evidence', () => {
    const prompt = buildInterpretationPrompt({
      command: 'timeline',
      evidence: SAMPLE_TIMELINE,
      promptKind: 'timeline-narrative',
      outputContract: TIMELINE_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (service) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'timeline',
      userIntent: 'service: api',
      evidence: SAMPLE_TIMELINE,
      promptKind: 'timeline-narrative',
      outputContract: TIMELINE_AI_CONTRACT,
    });

    expect(prompt).toContain('service: api');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'timeline',
      evidence: SAMPLE_TIMELINE,
      promptKind: 'timeline-narrative',
      outputContract: TIMELINE_AI_CONTRACT,
    });

    expect(prompt).toContain('Narrative');
    expect(prompt).toContain('Gaps / Next checks');
    expect(prompt).toContain('phases');
  });
});
