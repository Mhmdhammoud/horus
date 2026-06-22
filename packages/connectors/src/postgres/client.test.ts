import { describe, it, expect } from 'vitest';
import { quoteIdent, PostgresStateProvider, PostgresStateClient } from './index.js';

describe('quoteIdent (SQL identifier safety)', () => {
  it('accepts plain identifiers and double-quotes them', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('sync_jobs')).toBe('"sync_jobs"');
    expect(quoteIdent('_private$col')).toBe('"_private$col"');
  });

  it('rejects anything that could break out of the identifier', () => {
    for (const bad of ['users; DROP TABLE x', 'a"b', 'a b', "a'b", 'a-b', '1abc', 'a.b', '']) {
      expect(() => quoteIdent(bad)).toThrow(/Unsafe SQL identifier/);
    }
  });
});

describe('PostgresStateProvider', () => {
  it('is a state provider with the expected identity', () => {
    const p = new PostgresStateProvider(
      new PostgresStateClient({ url: 'postgres://localhost/db', allowlist: [] }),
      { database: 'db', collections: [], staleHours: 24 },
    );
    expect(p.id).toBe('postgres');
    expect(p.kind).toBe('state');
  });
});
