import { describe, it, expect } from 'vitest';
import { createMockedProviderAdapter } from './provider-execution.js';
import { LOCAL_PROVIDER_IDS } from './local-providers.js';
import type { ProviderRunInput } from './provider-execution.js';

const BASE_INPUT: ProviderRunInput = {
  providerId: 'codex',
  prompt: 'Summarise what caused the incident',
  timeoutMs: 5000,
  requestId: 'req-test-001',
};

// ---------------------------------------------------------------------------
// success mode
// ---------------------------------------------------------------------------

describe('createMockedProviderAdapter — success', () => {
  const adapter = createMockedProviderAdapter('success');

  it('returns ok: true', async () => {
    const result = await adapter.run(BASE_INPUT);
    expect(result.ok).toBe(true);
  });

  it('output carries the correct providerId', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (!result.ok) throw new Error('expected ok');
    expect(result.output.providerId).toBe('codex');
  });

  it('output text is non-empty and includes prompt excerpt', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (!result.ok) throw new Error('expected ok');
    expect(result.output.text).toBeTruthy();
    expect(result.output.text).toContain('Summarise');
  });

  it('output durationMs is a non-negative number', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (!result.ok) throw new Error('expected ok');
    expect(result.output.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('works for all five canonical provider IDs', async () => {
    for (const id of LOCAL_PROVIDER_IDS) {
      const result = await adapter.run({ ...BASE_INPUT, providerId: id });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.output.providerId).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// failure mode
// ---------------------------------------------------------------------------

describe('createMockedProviderAdapter — failure', () => {
  const adapter = createMockedProviderAdapter('failure');

  it('returns ok: false', async () => {
    const result = await adapter.run(BASE_INPUT);
    expect(result.ok).toBe(false);
  });

  it('error code is "execution-failed"', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.code).toBe('execution-failed');
  });

  it('error message is non-empty and includes providerId', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.message).toBeTruthy();
    expect(result.error.message).toContain('codex');
  });

  it('error.providerId matches input.providerId', async () => {
    const result = await adapter.run({ ...BASE_INPUT, providerId: 'gemini' });
    if (result.ok) throw new Error('expected failure');
    expect(result.error.providerId).toBe('gemini');
  });
});

// ---------------------------------------------------------------------------
// timeout mode
// ---------------------------------------------------------------------------

describe('createMockedProviderAdapter — timeout', () => {
  const adapter = createMockedProviderAdapter('timeout');

  it('returns ok: false', async () => {
    const result = await adapter.run(BASE_INPUT);
    expect(result.ok).toBe(false);
  });

  it('error code is "timeout"', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (result.ok) throw new Error('expected timeout');
    expect(result.error.code).toBe('timeout');
  });

  it('error message includes the timeout value from input', async () => {
    const result = await adapter.run({ ...BASE_INPUT, timeoutMs: 8000 });
    if (result.ok) throw new Error('expected timeout');
    expect(result.error.message).toContain('8000');
  });

  it('falls back to a default timeout when timeoutMs is omitted', async () => {
    const input: ProviderRunInput = { providerId: 'claude', prompt: 'test' };
    const result = await adapter.run(input);
    if (result.ok) throw new Error('expected timeout');
    expect(result.error.message).toContain('30000');
  });
});

// ---------------------------------------------------------------------------
// unsupported mode
// ---------------------------------------------------------------------------

describe('createMockedProviderAdapter — unsupported', () => {
  const adapter = createMockedProviderAdapter('unsupported');

  it('returns ok: false', async () => {
    const result = await adapter.run(BASE_INPUT);
    expect(result.ok).toBe(false);
  });

  it('error code is "unsupported"', async () => {
    const result = await adapter.run(BASE_INPUT);
    if (result.ok) throw new Error('expected unsupported');
    expect(result.error.code).toBe('unsupported');
  });

  it('error message clearly names the unsupported provider', async () => {
    const result = await adapter.run({ ...BASE_INPUT, providerId: 'cursor' });
    if (result.ok) throw new Error('expected unsupported');
    expect(result.error.message).toContain('cursor');
  });

  it('error.providerId matches input.providerId', async () => {
    const result = await adapter.run({ ...BASE_INPUT, providerId: 'kimi' });
    if (result.ok) throw new Error('expected unsupported');
    expect(result.error.providerId).toBe('kimi');
  });
});

// ---------------------------------------------------------------------------
// discriminated union — callers must narrow before accessing fields
// ---------------------------------------------------------------------------

describe('ProviderRunResult discriminated union', () => {
  it('ok:true branch has no error field at runtime', async () => {
    const adapter = createMockedProviderAdapter('success');
    const result = await adapter.run(BASE_INPUT);
    expect(result).not.toHaveProperty('error');
  });

  it('ok:false branch has no output field at runtime', async () => {
    const adapter = createMockedProviderAdapter('failure');
    const result = await adapter.run(BASE_INPUT);
    expect(result).not.toHaveProperty('output');
  });
});
