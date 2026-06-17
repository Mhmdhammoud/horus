/**
 * HOR-211 — Shared command-level AI interpretation helper.
 *
 * Several Horus commands expose (or will expose) an optional `--ai` flag that
 * interprets the deterministic evidence the command already gathered:
 * `what-changed`, `timeline`, `blast-radius`, `architecture`, `onboard`,
 * `readiness`, `changes`, `logs`, `metrics`, `state`, `queues --live`, `score`.
 *
 * Without a shared helper, each command would re-implement provider resolution,
 * the grounding prompt, error handling, and the evidence/interpretation
 * separation. This module owns the command-level concerns that are NOT
 * investigation-specific:
 *
 *   - the grounded prompt (interpret, don't invent; cite only given evidence)
 *   - a minimal text-completion provider contract (`InterpretationProvider`)
 *   - graceful degradation when no provider is configured or the call fails
 *
 * It deliberately does NOT replace the investigation NarrativeProvider contract
 * (NarrativeInput → NarrativeOutput with citations); that remains the canonical
 * path for `investigate --ai`. `AnthropicNarrativeProvider` implements both:
 * `render` for the structured investigation narrative and `interpret` for
 * generic command interpretation.
 *
 * AI never creates evidence. It only interprets the evidence a command provides.
 */

/** Command-specific prompt flavor. Determines the interpretation guidance. */
export type InterpretationPromptKind =
  | 'change-risk'
  | 'timeline-narrative'
  | 'blast-radius'
  | 'system-explanation'
  | 'readiness'
  | 'evidence-summary';

/** What a command passes to the helper after it has gathered deterministic evidence. */
export interface InterpretationRequest {
  /** Command name, e.g. 'what-changed'. Used in the prompt and the rendered header. */
  command: string;
  /** Optional user question/hint that scopes the interpretation. */
  userIntent?: string;
  /**
   * Structured deterministic evidence the command produced. Prefer a plain object
   * over pre-rendered terminal strings so the model sees facts, not formatting.
   */
  evidence: unknown;
  /** Command-specific prompt flavor. */
  promptKind: InterpretationPromptKind;
  /** Command-specific description of the desired output shape/sections. */
  outputContract: string;
}

/**
 * Minimal text-completion contract for command-level interpretation. Kept separate
 * from `NarrativeProvider` (which is investigation-specific). A single provider can
 * implement both — `AnthropicNarrativeProvider` does.
 */
export interface InterpretationProvider {
  readonly name: string;
  /** Send a fully-built prompt and return the model's raw text response. */
  interpret(prompt: string): Promise<string>;
}

/** A renderable result or a graceful warning. Never throws back to the command. */
export interface InterpretationResult {
  ok: boolean;
  command: string;
  promptKind: InterpretationPromptKind;
  provider?: string;
  model?: string;
  /** Present when `ok`: the model's interpretation text. */
  text?: string;
  /** Present when `!ok`: a user-facing reason (provider unavailable / error / empty). */
  warning?: string;
}

/**
 * The evidence-only grounding rules shared by every command-level `--ai` prompt.
 * Exported so tests can assert the prompt carries the grounding contract.
 */
export const INTERPRETATION_GROUNDING_RULES: readonly string[] = [
  'You are interpreting Horus evidence, not gathering new evidence.',
  'Do not invent files, commits, services, queues, logs, metrics, dashboards, owners, or timestamps.',
  'Use only the evidence provided above — any fact not present in it is a hallucination.',
  'Clearly separate "Evidence used" from "Interpretation".',
  'State your confidence and call out any missing evidence that would change the conclusion.',
  'When suggesting next checks, prefer exact follow-up Horus commands.',
];

const PROMPT_KIND_GUIDANCE: Record<InterpretationPromptKind, string> = {
  'change-risk':
    'Assess which changes carry the most risk and why, ranking by likely impact, grounded only in the evidence.',
  'timeline-narrative':
    'Narrate the ordering of changes and evidence into phases; flag suspicious ordering and gaps in coverage.',
  'blast-radius':
    'Explain severity, likely user impact, containment, and safe mitigations for the affected dependencies.',
  'system-explanation':
    'Explain how this system/subsystem works at onboarding quality, grounded in the evidence.',
  readiness:
    'Summarize readiness and risk, then prioritize what to do next before proceeding.',
  'evidence-summary':
    'Summarize what the evidence shows. Do not assert a root cause the evidence does not support.',
};

function stringifyEvidence(evidence: unknown): string {
  if (typeof evidence === 'string') return evidence;
  try {
    return JSON.stringify(evidence, null, 2);
  } catch {
    return String(evidence);
  }
}

/**
 * Build the grounded command-level interpretation prompt. Exported so commands can
 * preview/snapshot it and tests can assert the grounding contract is present.
 */
export function buildInterpretationPrompt(req: InterpretationRequest): string {
  const guidance = PROMPT_KIND_GUIDANCE[req.promptKind] ?? PROMPT_KIND_GUIDANCE['evidence-summary'];
  const evidenceBlock = stringifyEvidence(req.evidence);
  const rules = INTERPRETATION_GROUNDING_RULES.map((r) => `- ${r}`).join('\n');
  return `You are the Horus AI interpretation layer for the \`${req.command}\` command.
Task kind: ${req.promptKind}. ${guidance}
${req.userIntent ? `\nUser intent: ${req.userIntent}\n` : ''}
Evidence used (this is the ONLY ground truth — interpret it, do not extend it):
${evidenceBlock}

Output contract:
${req.outputContract}

Rules:
${rules}
- End with a "Confidence:" line (low | medium | high) and a "Next checks:" list of concrete Horus commands.`;
}

/**
 * Run a command-level interpretation. Never throws: a missing provider, a provider
 * error, or an empty response all degrade to `{ ok: false, warning }` so the command
 * can still print its deterministic output and simply append the warning.
 *
 * @param provider The resolved interpretation provider, or `null`/`undefined` when
 *                 none is configured (yields the "provider unavailable" warning).
 * @param opts.model Optional model id to surface in the result/header.
 */
export async function generateInterpretation(
  req: InterpretationRequest,
  provider: InterpretationProvider | null | undefined,
  opts?: { model?: string },
): Promise<InterpretationResult> {
  const base = {
    ok: false as const,
    command: req.command,
    promptKind: req.promptKind,
    ...(opts?.model ? { model: opts.model } : {}),
  };
  if (!provider) {
    return {
      ...base,
      warning:
        'No AI provider configured. Run `horus connect ai` or set ANTHROPIC_API_KEY to enable --ai.',
    };
  }
  const prompt = buildInterpretationPrompt(req);
  try {
    const text = (await provider.interpret(prompt))?.trim() ?? '';
    if (!text) {
      return { ...base, provider: provider.name, warning: 'AI provider returned an empty response.' };
    }
    return {
      ok: true,
      command: req.command,
      promptKind: req.promptKind,
      provider: provider.name,
      ...(opts?.model ? { model: opts.model } : {}),
      text,
    };
  } catch (err) {
    return {
      ...base,
      provider: provider.name,
      warning: `AI interpretation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Render an interpretation result to a plain-text section (no terminal colors, so it
 * is reusable outside the CLI). The header keeps the AI output visually separate from
 * the deterministic command output; callers print this AFTER their own output.
 */
export function renderInterpretation(result: InterpretationResult): string {
  const attribution = result.model
    ? ` (${result.provider ?? 'ai'}, ${result.model})`
    : result.provider
      ? ` (${result.provider})`
      : '';
  const header = `── AI Interpretation${attribution} ──`;
  if (!result.ok) {
    return `${header}\n${result.warning ?? 'AI interpretation unavailable.'}`;
  }
  return `${header}\n${result.text ?? ''}`;
}
