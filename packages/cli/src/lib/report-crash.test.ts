import { describe, it, expect } from 'vitest';
import { reportCrash } from './report-crash.js';

describe('reportCrash (HOR-439 error-message surface)', () => {
  it('prints the original error first, then nudges to `horus report`', () => {
    const lines: string[] = [];
    reportCrash(new Error('explain crashed on a monorepo'), (...args) =>
      lines.push(args.map(String).join(' ')),
    );
    const out = lines.join('\n');
    expect(out).toContain('explain crashed on a monorepo');
    expect(out).toContain('horus report');
    // Error is surfaced before the nudge so the failure stays the primary signal.
    expect(out.indexOf('explain crashed')).toBeLessThan(out.indexOf('horus report'));
  });

  it('defaults to console.error and still surfaces the report path', () => {
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(' '));
    try {
      reportCrash(new Error('boom'));
    } finally {
      console.error = original;
    }
    expect(captured.join('\n')).toContain('horus report');
  });
});
