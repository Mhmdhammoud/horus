/**
 * HOR-209 — `horus logs --raw` defaults to error+ (matching the summary), with
 * --level override and --all-levels escape hatch.
 */
import { describe, it, expect } from 'vitest';
import { resolveRawLevel } from './logs.js';

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
