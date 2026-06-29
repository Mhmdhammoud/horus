import { describe, it, expect } from 'vitest';
import {
  decideFeedbackNudge,
  isSuppressed,
  MIN_AGE_MS,
  RATE_LIMIT_MS,
  type LastInvestigation,
  type NudgeState,
} from './feedback-nudge.js';

const NOW = 1_700_000_000_000;
const FRESH_STATE: NudgeState = { lastPromptMs: 0, promptedIds: [] };
// An investigation old enough to ask about (created well before MIN_AGE ago).
const oldInvestigation = (over: Partial<LastInvestigation> = {}): LastInvestigation => ({
  id: 'inv-1',
  title: 'checkout latency spike',
  createdAtMs: NOW - MIN_AGE_MS - 60_000,
  ...over,
});

describe('decideFeedbackNudge', () => {
  it('asks about an old, unlabeled investigation when nothing blocks', () => {
    const target = decideFeedbackNudge({
      last: oldInvestigation(),
      labeled: false,
      state: FRESH_STATE,
      nowMs: NOW,
    });
    expect(target?.id).toBe('inv-1');
  });

  it('stays silent when there is no investigation', () => {
    expect(decideFeedbackNudge({ last: null, labeled: false, state: FRESH_STATE, nowMs: NOW })).toBeNull();
  });

  it('stays silent when the investigation is already labeled', () => {
    expect(
      decideFeedbackNudge({ last: oldInvestigation(), labeled: true, state: FRESH_STATE, nowMs: NOW }),
    ).toBeNull();
  });

  it('never prompts prematurely — skips an investigation younger than MIN_AGE', () => {
    const tooFresh = oldInvestigation({ createdAtMs: NOW - (MIN_AGE_MS - 60_000) });
    expect(
      decideFeedbackNudge({ last: tooFresh, labeled: false, state: FRESH_STATE, nowMs: NOW }),
    ).toBeNull();
  });

  it('is one-time per investigation — skips an id already prompted', () => {
    const state: NudgeState = { lastPromptMs: 0, promptedIds: ['inv-1'] };
    expect(decideFeedbackNudge({ last: oldInvestigation(), labeled: false, state, nowMs: NOW })).toBeNull();
  });

  it('rate-limits — skips when we nudged within the rate-limit window', () => {
    const state: NudgeState = { lastPromptMs: NOW - (RATE_LIMIT_MS - 60_000), promptedIds: [] };
    expect(decideFeedbackNudge({ last: oldInvestigation(), labeled: false, state, nowMs: NOW })).toBeNull();
  });

  it('asks again once the rate-limit window has elapsed (different investigation)', () => {
    const state: NudgeState = { lastPromptMs: NOW - (RATE_LIMIT_MS + 60_000), promptedIds: ['inv-0'] };
    const target = decideFeedbackNudge({ last: oldInvestigation(), labeled: false, state, nowMs: NOW });
    expect(target?.id).toBe('inv-1');
  });
});

describe('isSuppressed', () => {
  const TTY = true;
  const interactiveArgv = ['node', 'horus', 'status'];

  it('is NOT suppressed for an interactive, plain command', () => {
    expect(isSuppressed({}, TTY, interactiveArgv)).toBe(false);
  });

  it('suppresses on HORUS_NO_INPUT', () => {
    expect(isSuppressed({ HORUS_NO_INPUT: '1' }, TTY, interactiveArgv)).toBe(true);
  });

  it('suppresses under CI', () => {
    expect(isSuppressed({ CI: 'true' }, TTY, interactiveArgv)).toBe(true);
  });

  it('suppresses on a non-TTY', () => {
    expect(isSuppressed({}, false, interactiveArgv)).toBe(true);
  });

  it('suppresses with --json', () => {
    expect(isSuppressed({}, TTY, ['node', 'horus', 'status', '--json'])).toBe(true);
  });

  it('suppresses with --no-input', () => {
    expect(isSuppressed({}, TTY, ['node', 'horus', 'status', '--no-input'])).toBe(true);
  });

  it('suppresses during the feedback command (redundant)', () => {
    expect(isSuppressed({}, TTY, ['node', 'horus', 'feedback'])).toBe(true);
  });

  it('suppresses during the mcp server', () => {
    expect(isSuppressed({}, TTY, ['node', 'horus', 'mcp'])).toBe(true);
  });
});
