import { describe, it, expect } from 'vitest';
import { runProvidersDoctorCommand, buildProviderResults } from './providers-doctor.js';
import {
  createLocalProviderRegistry,
  DEFAULT_LOCAL_PROVIDER_REGISTRY,
  LOCAL_PROVIDER_IDS,
} from '@horus/ai';

function captureOutput(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

describe('runProvidersDoctorCommand', () => {
  it('exits 0', async () => {
    const { code } = await captureOutput((write) => runProvidersDoctorCommand({ write }));
    expect(code).toBe(0);
  });

  it('includes all five supported provider IDs in output', async () => {
    const { lines } = await captureOutput((write) => runProvidersDoctorCommand({ write }));
    const output = lines.join('\n');
    for (const id of LOCAL_PROVIDER_IDS) {
      expect(output).toContain(id);
    }
  });

  it('shows unavailable status for all providers (detection not yet implemented)', async () => {
    const { lines } = await captureOutput((write) => runProvidersDoctorCommand({ write }));
    const output = lines.join('\n');
    expect(output).toContain('not found on PATH');
  });

  it('includes next-step hints for unavailable providers', async () => {
    const { lines } = await captureOutput((write) => runProvidersDoctorCommand({ write }));
    const output = lines.join('\n');
    expect(output).toContain('→');
  });

  it('includes cloud provider fallback hint', async () => {
    const { lines } = await captureOutput((write) => runProvidersDoctorCommand({ write }));
    const output = lines.join('\n');
    expect(output).toContain('ANTHROPIC_API_KEY');
  });

  it('accepts an injected registry and renders only its providers', async () => {
    const custom = createLocalProviderRegistry([{ id: 'codex', displayName: 'Custom Codex' }]);
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ registry: custom, write }),
    );
    const output = lines.join('\n');
    expect(output).toContain('codex');
    expect(output).not.toContain('claude');
    expect(output).not.toContain('gemini');
  });

  it('handles empty registry without throwing', async () => {
    const empty = createLocalProviderRegistry([]);
    const { code } = await captureOutput((write) =>
      runProvidersDoctorCommand({ registry: empty, write }),
    );
    expect(code).toBe(0);
  });
});

describe('buildProviderResults', () => {
  it('returns one result per provider in the default registry', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY);
    expect(results).toHaveLength(LOCAL_PROVIDER_IDS.length);
  });

  it('all results are unavailable (detection not yet implemented)', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY);
    for (const r of results) {
      expect(r.status).toBe('unavailable');
    }
  });

  it('maps provider IDs in registry order', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual([...LOCAL_PROVIDER_IDS]);
  });

  it('includes install guidance in the detail field', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY);
    for (const r of results) {
      expect(r.detail).toBeTruthy();
      expect(r.detail).toContain('install');
    }
  });

  it('handles empty registry without throwing', () => {
    const empty = createLocalProviderRegistry([]);
    const results = buildProviderResults(empty);
    expect(results).toHaveLength(0);
  });
});
