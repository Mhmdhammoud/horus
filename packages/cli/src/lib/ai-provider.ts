/**
 * Shared AI narrative provider resolution (HOR-215).
 *
 * investigate/replay/postmortem all build the Anthropic provider the same way: resolve
 * the API key + model saved via `horus connect ai` (with the ANTHROPIC_API_KEY env as
 * fallback), so `--ai` works consistently across commands. Without this, replay/postmortem
 * ignored the connected key and silently required the env var.
 */

import { loadConfig, resolveAiSettings } from '@horus/core';
import { AnthropicNarrativeProvider, generateInterpretation } from '@horus/ai';
import type {
  NarrativeProvider,
  InterpretationProvider,
  InterpretationRequest,
  InterpretationResult,
} from '@horus/ai';

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * Resolve the saved AI key + model the same way buildNarrativeProvider does, but
 * also fold in the ANTHROPIC_API_KEY env fallback so callers can detect "no provider
 * configured" before making a network call. `modelOverride` (CLI `--ai-model`) wins.
 */
async function resolveAiCredentials(opts: {
  config?: string;
  modelOverride?: string;
}): Promise<{ apiKey?: string; model: string }> {
  let apiKey: string | undefined;
  let savedModel: string | undefined;
  try {
    const config = await loadConfig(opts.config);
    const ai = resolveAiSettings(config);
    apiKey = ai.anthropicApiKey;
    savedModel = ai.model;
  } catch {
    // No loadable config — fall back to the env var below.
  }
  apiKey = apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? undefined;
  return { apiKey, model: opts.modelOverride ?? savedModel ?? DEFAULT_MODEL };
}

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

/**
 * HOR-211 — run a command-level AI interpretation over deterministic evidence.
 *
 * Commands call this AFTER printing their deterministic output, only when `--ai`
 * is passed. It reuses the same key/model resolution as `investigate --ai`
 * (saved `connect ai` credentials → ANTHROPIC_API_KEY env). It never throws:
 * when no provider is configured or the call fails it returns an
 * `{ ok: false, warning }` result, so deterministic output is never suppressed.
 *
 * Render the returned result with `renderInterpretation` from `@horus/ai`.
 */
export async function renderAiInterpretation(
  opts: InterpretationRequest & {
    config?: string;
    modelOverride?: string;
    /** Injectable provider for tests — bypasses credential resolution. */
    provider?: InterpretationProvider;
  },
): Promise<InterpretationResult> {
  const { config, modelOverride, provider: injected, command, evidence, promptKind, outputContract, userIntent } =
    opts;
  const request: InterpretationRequest = {
    command,
    evidence,
    promptKind,
    outputContract,
    ...(userIntent ? { userIntent } : {}),
  };

  if (injected) {
    return generateInterpretation(request, injected);
  }

  const { apiKey, model } = await resolveAiCredentials({ config, modelOverride });
  if (!apiKey) {
    // No configured provider — graceful "unavailable" result, no network call.
    return generateInterpretation(request, null, { model });
  }
  const provider = new AnthropicNarrativeProvider({ model, apiKey });
  return generateInterpretation(request, provider, { model });
}
