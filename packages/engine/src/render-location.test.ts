/**
 * HOR-211 — symbol locations use real line ranges; no meaningless `:0`.
 */
import { describe, it, expect } from 'vitest';
import { formatSymbolLocation } from './render.js';

describe('formatSymbolLocation', () => {
  it('renders a start-end range when both lines are known', () => {
    expect(formatSymbolLocation('src/a.ts', 15, 387)).toBe('src/a.ts:15-387');
  });

  it('renders a single line when there is no distinct end', () => {
    expect(formatSymbolLocation('src/a.ts', 115)).toBe('src/a.ts:115');
    expect(formatSymbolLocation('src/a.ts', 115, 115)).toBe('src/a.ts:115');
  });

  it('renders a bare path (no :0) when there is no line range (e.g. File nodes)', () => {
    expect(formatSymbolLocation('src/a.ts')).toBe('src/a.ts');
    expect(formatSymbolLocation('src/a.ts', 0)).toBe('src/a.ts');
    expect(formatSymbolLocation('src/a.ts', undefined, 50)).toBe('src/a.ts');
  });
});

import { symbolDisplayName } from './render.js';

describe('symbolDisplayName (HOR-214)', () => {
  it('qualifies a class member with its owning class', () => {
    expect(symbolDisplayName({ name: 'constructor', className: 'GaiaController' })).toBe('GaiaController.constructor');
    expect(symbolDisplayName({ name: 'createSale', className: 'SaleService' })).toBe('SaleService.createSale');
  });

  it('returns the bare name when there is no class context', () => {
    expect(symbolDisplayName({ name: 'startWorkers' })).toBe('startWorkers');
    expect(symbolDisplayName({ name: 'GaiaController', className: '' })).toBe('GaiaController');
  });

  it('does not double-qualify a name that already includes a dot', () => {
    expect(symbolDisplayName({ name: 'SaleService.createSale', className: 'SaleService' })).toBe('SaleService.createSale');
  });
});
