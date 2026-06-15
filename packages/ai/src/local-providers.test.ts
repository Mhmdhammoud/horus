/**
 * HOR-74 — Local AI provider registry contract tests.
 */

import { describe, it, expect } from 'vitest';
import {
  LOCAL_PROVIDER_IDS,
  createLocalProviderRegistry,
  lookupLocalProvider,
  DEFAULT_LOCAL_PROVIDER_REGISTRY,
} from './local-providers.js';

describe('LOCAL_PROVIDER_IDS', () => {
  it('contains all five canonical providers', () => {
    expect(LOCAL_PROVIDER_IDS).toHaveLength(5);
    expect(LOCAL_PROVIDER_IDS).toContain('codex');
    expect(LOCAL_PROVIDER_IDS).toContain('claude');
    expect(LOCAL_PROVIDER_IDS).toContain('kimi');
    expect(LOCAL_PROVIDER_IDS).toContain('gemini');
    expect(LOCAL_PROVIDER_IDS).toContain('cursor');
  });
});

describe('createLocalProviderRegistry', () => {
  it('registers all default providers when called with no arguments', () => {
    const registry = createLocalProviderRegistry();
    expect(registry.providers).toHaveLength(5);
  });

  it('preserves insertion order', () => {
    const registry = createLocalProviderRegistry();
    const ids = registry.providers.map((p) => p.id);
    expect(ids).toEqual(['codex', 'claude', 'kimi', 'gemini', 'cursor']);
  });

  it('throws on duplicate provider ID', () => {
    expect(() =>
      createLocalProviderRegistry([
        { id: 'codex', displayName: 'OpenAI Codex CLI' },
        { id: 'codex', displayName: 'Duplicate Codex' },
      ]),
    ).toThrow('Duplicate provider ID: codex');
  });

  it('returns a provider by ID via get()', () => {
    const registry = createLocalProviderRegistry();
    const descriptor = registry.get('claude');
    expect(descriptor).toBeDefined();
    expect(descriptor?.id).toBe('claude');
    expect(descriptor?.displayName).toBeTruthy();
  });

  it('returns undefined for an unknown ID via get()', () => {
    const registry = createLocalProviderRegistry();
    expect(registry.get('unknown' as never)).toBeUndefined();
  });

  it('accepts a custom descriptor list', () => {
    const registry = createLocalProviderRegistry([
      { id: 'gemini', displayName: 'Custom Gemini' },
    ]);
    expect(registry.providers).toHaveLength(1);
    expect(registry.get('gemini')?.displayName).toBe('Custom Gemini');
  });

  it('does not expose auth details (only id and displayName on descriptor)', () => {
    const registry = createLocalProviderRegistry();
    const descriptor = registry.get('codex');
    const keys = Object.keys(descriptor ?? {});
    expect(keys).toEqual(['id', 'displayName']);
  });
});

describe('lookupLocalProvider', () => {
  it('returns found=true with the provider for a registered ID', () => {
    const registry = createLocalProviderRegistry();
    const result = lookupLocalProvider(registry, 'kimi');
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.provider.id).toBe('kimi');
    }
  });

  it('returns found=false with the queried ID for a missing provider', () => {
    const registry = createLocalProviderRegistry();
    const result = lookupLocalProvider(registry, 'nonexistent');
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.id).toBe('nonexistent');
    }
  });

  it('returns found=false for an empty registry', () => {
    const registry = createLocalProviderRegistry([]);
    const result = lookupLocalProvider(registry, 'codex');
    expect(result.found).toBe(false);
  });
});

describe('DEFAULT_LOCAL_PROVIDER_REGISTRY', () => {
  it('contains all five canonical providers', () => {
    expect(DEFAULT_LOCAL_PROVIDER_REGISTRY.providers).toHaveLength(5);
  });

  it('can look up each canonical provider', () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const result = lookupLocalProvider(DEFAULT_LOCAL_PROVIDER_REGISTRY, id);
      expect(result.found).toBe(true);
    }
  });

  it('returns found=false for an unregistered ID', () => {
    const result = lookupLocalProvider(DEFAULT_LOCAL_PROVIDER_REGISTRY, 'unknown-tool');
    expect(result.found).toBe(false);
  });
});
