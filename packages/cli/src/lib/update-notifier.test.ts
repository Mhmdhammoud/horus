import { describe, it, expect } from 'vitest';
import { decideNotification, isSuppressed, type UpdateCache } from './update-notifier.js';

const NOW = 1_700_000_000_000;

describe('update notifier — decideNotification (HOR-383)', () => {
  it('emits a hint when the cached latest is newer than current', () => {
    const cache: UpdateCache = { lastCheckMs: NOW, latest: '0.9.0' };
    const { hint } = decideNotification(cache, '0.8.19', NOW);
    expect(hint).toContain('0.9.0');
    expect(hint).toContain('0.8.19');
    expect(hint).toContain('horus update');
  });

  it('no hint when current is up to date or ahead', () => {
    expect(decideNotification({ lastCheckMs: NOW, latest: '0.8.19' }, '0.8.19', NOW).hint).toBeNull();
    expect(decideNotification({ lastCheckMs: NOW, latest: '0.8.10' }, '0.8.19', NOW).hint).toBeNull();
  });

  it('no hint and no throw for a non-release version (e.g. dev build)', () => {
    expect(decideNotification({ lastCheckMs: NOW, latest: '0.9.0' }, 'dev', NOW).hint).toBeNull();
  });

  it('no hint with no cache, but a refresh is due', () => {
    const d = decideNotification(null, '0.8.19', NOW);
    expect(d.hint).toBeNull();
    expect(d.refreshDue).toBe(true);
  });

  it('refresh is due only when the cache is older than 24h', () => {
    expect(decideNotification({ lastCheckMs: NOW, latest: '0.8.19' }, '0.8.19', NOW).refreshDue).toBe(false);
    expect(
      decideNotification({ lastCheckMs: NOW - 25 * 3_600_000, latest: '0.8.19' }, '0.8.19', NOW).refreshDue,
    ).toBe(true);
  });
});

describe('update notifier — isSuppressed (HOR-383)', () => {
  it('suppresses for opt-out / CI / non-TTY / --json, allows an interactive TTY', () => {
    expect(isSuppressed({ HORUS_NO_UPDATE_CHECK: '1' }, true, [])).toBe(true);
    expect(isSuppressed({ CI: 'true' }, true, [])).toBe(true);
    expect(isSuppressed({}, false, [])).toBe(true); // non-interactive stderr
    expect(isSuppressed({}, true, ['investigate', '--json'])).toBe(true);
    expect(isSuppressed({}, true, ['investigate'])).toBe(false);
  });
});
