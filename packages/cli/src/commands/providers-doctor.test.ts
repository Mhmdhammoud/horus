import { describe, it, expect } from 'vitest';
import { runProvidersDoctorCommand, buildProviderResults } from './providers-doctor.js';
import {
  createLocalProviderRegistry,
  DEFAULT_LOCAL_PROVIDER_REGISTRY,
  LOCAL_PROVIDER_IDS,
  type LocalProviderId,
  type LocalProviderResult,
} from '@horus/ai';

function captureOutput(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

/** Detector that always returns 'unavailable' — for stable test output. */
function detectNone(id: LocalProviderId): LocalProviderResult {
  return { id, status: 'unavailable', detail: `${id}: command not found` };
}

/** Detector that always returns 'installed' — binary present, not configured. */
function detectInstalled(id: LocalProviderId): LocalProviderResult {
  return { id, status: 'installed', detail: `${id}: found on PATH` };
}

/** Detector that always returns 'ready'. */
function detectReady(id: LocalProviderId): LocalProviderResult {
  return { id, status: 'ready', detail: `${id}: authenticated` };
}

// ---------------------------------------------------------------------------

describe('runProvidersDoctorCommand', () => {
  it('exits 0', async () => {
    const { code } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: null }),
    );
    expect(code).toBe(0);
  });

  it('includes all five supported provider IDs in output', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    for (const id of LOCAL_PROVIDER_IDS) {
      expect(output).toContain(id);
    }
  });

  it('shows unavailable status when detector returns unavailable', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('not found on PATH');
  });

  it('shows installed status when detector returns installed', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectInstalled, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('installed');
  });

  it('shows ready status when detector returns ready', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectReady, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('ready');
  });

  it('includes next-step hints for unavailable providers', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('→');
  });

  it('shows ANTHROPIC_API_KEY configured when key is present', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: 'sk-test-key' }),
    );
    const output = lines.join('\n');
    expect(output).toContain('ANTHROPIC_API_KEY configured');
  });

  it('shows ANTHROPIC_API_KEY not set when key is absent', async () => {
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ write, _detect: detectNone, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('ANTHROPIC_API_KEY not set');
    expect(output).toContain('ANTHROPIC_API_KEY');
  });

  it('accepts an injected registry and renders only its providers', async () => {
    const custom = createLocalProviderRegistry([{ id: 'codex', displayName: 'Custom Codex' }]);
    const { lines } = await captureOutput((write) =>
      runProvidersDoctorCommand({ registry: custom, write, _detect: detectNone, _anthropicKey: null }),
    );
    const output = lines.join('\n');
    expect(output).toContain('codex');
    expect(output).not.toContain('claude');
    expect(output).not.toContain('gemini');
  });

  it('handles empty registry without throwing', async () => {
    const empty = createLocalProviderRegistry([]);
    const { code } = await captureOutput((write) =>
      runProvidersDoctorCommand({ registry: empty, write, _detect: detectNone, _anthropicKey: null }),
    );
    expect(code).toBe(0);
  });
});

describe('buildProviderResults', () => {
  it('returns one result per provider in the default registry', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY, detectNone);
    expect(results).toHaveLength(LOCAL_PROVIDER_IDS.length);
  });

  it('returns unavailable when injected detector returns unavailable', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY, detectNone);
    for (const r of results) {
      expect(r.status).toBe('unavailable');
    }
  });

  it('returns installed when injected detector returns installed', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY, detectInstalled);
    for (const r of results) {
      expect(r.status).toBe('installed');
    }
  });

  it('maps provider IDs in registry order', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY, detectNone);
    const ids = results.map((r) => r.id);
    expect(ids).toEqual([...LOCAL_PROVIDER_IDS]);
  });

  it('includes detail from the detector', () => {
    const results = buildProviderResults(DEFAULT_LOCAL_PROVIDER_REGISTRY, detectNone);
    for (const r of results) {
      expect(r.detail).toBeTruthy();
      expect(r.detail).toContain('command not found');
    }
  });

  it('handles empty registry without throwing', () => {
    const empty = createLocalProviderRegistry([]);
    const results = buildProviderResults(empty, detectNone);
    expect(results).toHaveLength(0);
  });
});
