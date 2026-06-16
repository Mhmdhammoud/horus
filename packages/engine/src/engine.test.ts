import { describe, it, expect } from 'vitest';
import { queueFindingConfidence, logWindowFrom, looksDiffable, classifyLogRelevance } from './engine.js';

// ---------------------------------------------------------------------------
// logWindowFrom — duration parsing for --since (HOR-86)
// ---------------------------------------------------------------------------

describe('logWindowFrom', () => {
  it('parses hours: 2h subtracts 2 hours from now', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom('2h')).getTime();
    const after = Date.now();
    const expected = before - 2 * 3_600_000;
    expect(result).toBeGreaterThanOrEqual(expected - 100);
    expect(result).toBeLessThanOrEqual(after - 2 * 3_600_000 + 100);
  });

  it('parses days: 7d subtracts 7 days from now', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom('7d')).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 100);
    expect(result).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 100);
  });

  it('parses minutes: 30m subtracts 30 minutes from now', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom('30m')).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 30 * 60_000 - 100);
  });

  it('parses seconds: 90s subtracts 90 seconds from now', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom('90s')).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 90_000 - 100);
  });

  it('returns an ISO-8601 string', () => {
    const result = logWindowFrom('24h');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('defaults to 7 days ago when since is undefined', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom(undefined)).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 100);
    expect(result).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 100);
  });

  it('defaults to 7 days ago for a non-duration string (falls through to default)', () => {
    const before = Date.now();
    // A ref like HEAD~5 is not a duration — should fall back to 7d default
    const result = new Date(logWindowFrom('HEAD~5')).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 100);
    expect(result).toBeLessThanOrEqual(Date.now() - 7 * 86_400_000 + 100);
  });

  it('defaults to 7 days ago for an ISO date string', () => {
    const before = Date.now();
    const result = new Date(logWindowFrom('2026-01-01T00:00:00Z')).getTime();
    expect(result).toBeGreaterThanOrEqual(before - 7 * 86_400_000 - 100);
  });
});

// ---------------------------------------------------------------------------
// looksDiffable — ref/range detection for --since (HOR-86)
// ---------------------------------------------------------------------------

describe('looksDiffable', () => {
  it('returns true for a range notation (..)', () => {
    expect(looksDiffable('HEAD~5..HEAD')).toBe(true);
  });

  it('returns true for a commit sha', () => {
    expect(looksDiffable('abc1234')).toBe(true);
  });

  it('returns true for HEAD~N relative ref notation', () => {
    expect(looksDiffable('HEAD~3')).toBe(true);
    expect(looksDiffable('HEAD~5')).toBe(true);
  });

  it('returns true for a tag name', () => {
    expect(looksDiffable('v1.2.3')).toBe(true);
  });

  it('returns true for a branch name', () => {
    expect(looksDiffable('main')).toBe(true);
  });

  it('returns false for duration strings (log window specifiers, not git refs)', () => {
    expect(looksDiffable('2h')).toBe(false);
    expect(looksDiffable('7d')).toBe(false);
    expect(looksDiffable('30m')).toBe(false);
    expect(looksDiffable('90s')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(looksDiffable('')).toBe(false);
  });

  it('returns false for a whitespace-only string', () => {
    expect(looksDiffable('   ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queueFindingConfidence
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// classifyLogRelevance — seed-based log relevance classification (HOR-156)
// ---------------------------------------------------------------------------

describe('classifyLogRelevance', () => {
  it('classifies as direct when signature key matches seed term', () => {
    const r = classifyLogRelevance('E_SALE_TIMEOUT', [], ['sale', 'link'], undefined);
    expect(r.relevanceClass).toBe('direct');
  });

  it('classifies as direct when a service matches seed term', () => {
    const r = classifyLogRelevance('ERR_UNKNOWN', ['sales-service'], ['sale'], undefined);
    expect(r.relevanceClass).toBe('direct');
  });

  it('classifies as ambient when neither key nor services match', () => {
    const r = classifyLogRelevance('E_FULFILLMENT_SYNC_ERROR', ['scheduler-service'], ['sale', 'link'], undefined);
    expect(r.relevanceClass).toBe('ambient');
  });

  it('classifies as direct when service matches inputService', () => {
    const r = classifyLogRelevance('ERR_GENERIC', ['api-prod'], [], 'api-prod');
    expect(r.relevanceClass).toBe('direct');
  });

  it('classifies as direct when seedTerms is empty (no seed context)', () => {
    const r = classifyLogRelevance('ANY_ERROR', [], [], undefined);
    expect(r.relevanceClass).toBe('direct');
  });

  it('includes a relevanceReason string in all cases', () => {
    const r = classifyLogRelevance('E_SALE_TIMEOUT', [], ['sale'], undefined);
    expect(typeof r.relevanceReason).toBe('string');
    expect(r.relevanceReason.length).toBeGreaterThan(0);
  });
});
