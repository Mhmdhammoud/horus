/**
 * HOR-215 — buildNarrativeProvider resolves the model from the saved config (with a
 * CLI override winning) so replay/postmortem --ai share investigate's resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNarrativeProvider, renderAiInterpretation } from './ai-provider.js';
import type { InterpretationProvider } from '@horus/ai';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'horus-aiprov-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeConfig(ai: string): string {
  const p = join(dir, 'horus.config.js');
  writeFileSync(
    p,
    `export default {
  database: { url: "postgresql://horus:horus@localhost:5433/horus" },
  projects: [],
  ai: ${ai},
};
`,
    'utf8',
  );
  return p;
}

describe('buildNarrativeProvider (HOR-215)', () => {
  it('uses the saved model from config', async () => {
    const config = writeConfig('{ provider: "anthropic", anthropic: { model: "claude-haiku-4-5" } }');
    const { provider, model } = await buildNarrativeProvider({ config });
    expect(model).toBe('claude-haiku-4-5');
    expect(provider.name).toBe('anthropic');
  });

  it('a CLI model override wins over the saved model', async () => {
    const config = writeConfig('{ provider: "anthropic", anthropic: { model: "claude-haiku-4-5" } }');
    const { model } = await buildNarrativeProvider({ config, modelOverride: 'claude-opus-4-8' });
    expect(model).toBe('claude-opus-4-8');
  });

  it('falls back to the default model when none is configured', async () => {
    const config = writeConfig('{ provider: "anthropic" }');
    const { model } = await buildNarrativeProvider({ config });
    expect(model).toBe('claude-opus-4-8');
  });

  it('does not throw when no config is loadable (env-only path)', async () => {
    const { provider, model } = await buildNarrativeProvider({ config: join(dir, 'nope.js') });
    expect(provider.name).toBe('anthropic');
    expect(model).toBe('claude-opus-4-8');
  });
});

describe('renderAiInterpretation (HOR-211)', () => {
  function fake(impl: (p: string) => Promise<string>): InterpretationProvider {
    return { name: 'fake', interpret: impl };
  }

  it('is callable by a command without duplicating provider plumbing (success)', async () => {
    const result = await renderAiInterpretation({
      command: 'what-changed',
      evidence: { changes: 2 },
      promptKind: 'change-risk',
      outputContract: 'Rank risky changes.',
      provider: fake(async () => 'risk: low'),
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe('risk: low');
  });

  it('degrades gracefully when the injected provider errors', async () => {
    const result = await renderAiInterpretation({
      command: 'what-changed',
      evidence: {},
      promptKind: 'change-risk',
      outputContract: 'x',
      provider: fake(async () => {
        throw new Error('upstream 500');
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.warning).toContain('upstream 500');
  });

  it('returns a graceful "unavailable" result when no provider is configured', async () => {
    const prev = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const result = await renderAiInterpretation({
        config: join(dir, 'nope.js'),
        command: 'what-changed',
        evidence: {},
        promptKind: 'change-risk',
        outputContract: 'x',
      });
      expect(result.ok).toBe(false);
      expect(result.warning).toMatch(/connect ai|ANTHROPIC_API_KEY/i);
    } finally {
      if (prev !== undefined) process.env['ANTHROPIC_API_KEY'] = prev;
    }
  });
});
