import { describe, expect, it } from 'vitest';
import { horusConfigSchema } from './config.js';
import { PINNED_AXON_VERSION } from './version.js';

describe('horusConfigSchema', () => {
  it('applies defaults and requires a database url', () => {
    const parsed = horusConfigSchema.parse({
      database: { url: 'postgresql://horus:horus@localhost:5433/horus' },
    });
    expect(parsed.axon.hostUrl).toBe('http://127.0.0.1:8420');
    expect(parsed.axon.pinnedVersion).toBe(PINNED_AXON_VERSION);
    expect(parsed.models.reasoning).toBe('claude-opus-4-8');
    expect(parsed.repos).toEqual([]);
  });

  it('rejects a config without a database url', () => {
    expect(() => horusConfigSchema.parse({})).toThrow();
  });

  it('rejects a non-url axon host', () => {
    expect(() =>
      horusConfigSchema.parse({
        database: { url: 'x' },
        axon: { hostUrl: 'not-a-url' },
      }),
    ).toThrow();
  });
});
