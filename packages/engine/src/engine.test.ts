import { describe, it, expect } from 'vitest';
import { queueFindingConfidence } from './engine.js';

describe('queueFindingConfidence', () => {
  it('returns 0.65 when only starvation signals are present', () => {
    expect(queueFindingConfidence({ starvedCount: 1, backloggedCount: 0, failingCount: 0 })).toBe(0.65);
  });

  it('returns 0.65 for multiple starved queues with no backlog or failures', () => {
    expect(queueFindingConfidence({ starvedCount: 3, backloggedCount: 0, failingCount: 0 })).toBe(0.65);
  });

  it('returns 0.85 when a pure-backlog queue is present alongside starvation', () => {
    // This is the regression case: a queue with >100 waiting AND 0 active used to
    // appear in both starved and backlogged, holding confidence at 0.85 incorrectly.
    // After the fix, starved queues are excluded from backlogged, so a queue that is
    // only backlogged (has active workers) is the trigger here.
    expect(queueFindingConfidence({ starvedCount: 1, backloggedCount: 1, failingCount: 0 })).toBe(0.85);
  });

  it('returns 0.85 when only backlog is present', () => {
    expect(queueFindingConfidence({ starvedCount: 0, backloggedCount: 2, failingCount: 0 })).toBe(0.85);
  });

  it('returns 0.85 when failures are present with starvation but no backlog', () => {
    expect(queueFindingConfidence({ starvedCount: 1, backloggedCount: 0, failingCount: 1 })).toBe(0.85);
  });

  it('returns 0.85 when only failures are present', () => {
    expect(queueFindingConfidence({ starvedCount: 0, backloggedCount: 0, failingCount: 1 })).toBe(0.85);
  });
});
