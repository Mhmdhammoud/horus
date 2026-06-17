/**
 * HOR-202 — `horus timeline` defaults to a bounded recent window (parity with
 * `what-changed`) instead of all history.
 */
import { describe, it, expect } from 'vitest';
import { resolveTimelineWindow } from './timeline.js';

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
