/**
 * Shared AI narrative provider resolution (HOR-215).
 *
 * investigate/replay/postmortem all build the Anthropic provider the same way: resolve
 * the API key + model saved via `horus connect ai` (with the ANTHROPIC_API_KEY env as
 * fallback), so `--ai` works consistently across commands. Without this, replay/postmortem
 * ignored the connected key and silently required the env var.
 */

import { loadConfig, resolveAiSettings } from '@horus/core';
import { AnthropicNarrativeProvider } from '@horus/ai';
import type { NarrativeProvider } from '@horus/ai';

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Build a NarrativeProvider for `--ai`. Resolution order for the key/model: saved config
 * (`.horus/secrets.local.json` / config.json via `connect ai`) → ANTHROPIC_API_KEY env
 * (read inside AnthropicNarrativeProvider when no apiKey is passed). `modelOverride`
 * (CLI `--ai-model`) wins over the saved model.
 */
export async function buildNarrativeProvider(opts: {
  config?: string;
  modelOverride?: string;
}): Promise<{ provider: NarrativeProvider; model: string }> {
  let apiKey: string | undefined;
  let savedModel: string | undefined;
  try {
    const config = await loadConfig(opts.config);
    const ai = resolveAiSettings(config);
    apiKey = ai.anthropicApiKey;
    savedModel = ai.model;
  } catch {
    // No loadable config — fall back to the env var (read by the provider).
  }
  const model = opts.modelOverride ?? savedModel ?? DEFAULT_MODEL;
  const provider = new AnthropicNarrativeProvider({
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
  });
  return { provider, model };
}
