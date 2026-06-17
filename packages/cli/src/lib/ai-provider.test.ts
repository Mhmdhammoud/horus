/**
 * HOR-215 — buildNarrativeProvider resolves the model from the saved config (with a
 * CLI override winning) so replay/postmortem --ai share investigate's resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildNarrativeProvider } from './ai-provider.js';

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
