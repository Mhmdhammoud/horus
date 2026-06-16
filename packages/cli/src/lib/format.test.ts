import { describe, it, expect } from 'vitest';
import { formatDateTime } from './format.js';

describe('formatDateTime', () => {
  it('returns an empty string for null or undefined', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime(undefined)).toBe('');
  });

  it('formats an ISO date in local time with a UTC offset', () => {
    const d = new Date('2026-06-16T11:49:13.357Z');
    const out = formatDateTime(d);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
  });

  it('accepts a string input', () => {
    const out = formatDateTime('2026-06-16T11:49:13.357Z');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
  });

  it('accepts a numeric timestamp input', () => {
    const out = formatDateTime(Date.parse('2026-06-16T11:49:13.357Z'));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/);
  });

  it('falls back to stringifying invalid input', () => {
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});
