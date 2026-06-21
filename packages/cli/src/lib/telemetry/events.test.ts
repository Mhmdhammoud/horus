import { describe, it, expect } from 'vitest';
import { extractFlagNames } from './events.js';

describe('extractFlagNames (privacy boundary — names only, never values)', () => {
  it('keeps long-flag names and drops their values', () => {
    expect(
      extractFlagNames([
        'node',
        'horus',
        'investigate',
        'checkout latency spike',
        '--service',
        'payments-api',
        '--json',
      ]),
    ).toEqual(['service', 'json']);
  });

  it('handles --flag=value form without leaking the value', () => {
    const flags = extractFlagNames(['node', 'horus', 'logs', '--grep=password123', '--limit=50']);
    expect(flags).toEqual(['grep', 'limit']);
    expect(JSON.stringify(flags)).not.toContain('password123');
  });

  it('ignores positionals and short flags, and dedupes', () => {
    expect(extractFlagNames(['node', 'horus', 'x', '-v', 'arg', '--ai', '--ai'])).toEqual(['ai']);
  });

  it('returns empty when there are no long flags', () => {
    expect(extractFlagNames(['node', 'horus', 'status'])).toEqual([]);
  });
});
