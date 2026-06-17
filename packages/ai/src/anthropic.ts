/**
 * HOR-61 — Anthropic narrative provider adapter.
 *
 * Implements NarrativeProvider using the Anthropic Messages API (via native
 * fetch — no SDK dependency). The adapter builds a structured prompt from the
 * bounded NarrativeInput packet and parses a JSON NarrativeOutput from the
 * response.
 *
 * The adapter throws on API errors or unparseable responses. The caller
 * (renderNarrative) catches those and falls back to the deterministic summary —
 * the investigation report is never blocked by AI unavailability.
 */

import type {
  NarrativeInput,
  NarrativeOutput,
  NarrativeCitation,
  NarrativeProvider,
  NarrativeProviderOptions,
  AIHypothesisJudgment,
  AIRootCauseAssessment,
} from './contract.js';
import type { InterpretationProvider } from './interpretation.js';

export interface AnthropicProviderOptions {
  /** Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Model ID. Defaults to 'claude-opus-4-8'. */
  model?: string;
  /** Base URL override — useful for pointing tests at a mock server. Defaults to https://api.anthropic.com. */
  baseUrl?: string;
}

/**
 * Anthropic-backed NarrativeProvider.
 *
 * Reads the API key from opts.apiKey or ANTHROPIC_API_KEY env var. Model
 * defaults to 'claude-opus-4-8' and can be overridden per-instance.
 */
export class AnthropicNarrativeProvider implements NarrativeProvider, InterpretationProvider {
  readonly name = 'anthropic';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts?: AnthropicProviderOptions) {
    this.apiKey = opts?.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    this.model = opts?.model ?? 'claude-opus-4-8';
    this.baseUrl = opts?.baseUrl ?? 'https://api.anthropic.com';
  }

  async render(input: NarrativeInput, opts?: NarrativeProviderOptions): Promise<NarrativeOutput> {
    const ceiling = opts?.confidenceCeiling ?? input.reportConfidence;
    const prompt = buildPrompt(input, ceiling);
    const raw = await this.callApi(prompt);
    return parseOutput(raw, input, ceiling);
  }

  /**
   * HOR-211 — generic command-level interpretation. Reuses the same Messages API
   * call as render(), but with a caller-supplied command prompt (built by
   * buildInterpretationPrompt) instead of the investigation narrative prompt.
   * Returns the raw model text; the shared helper handles parsing/rendering.
   */
  async interpret(prompt: string): Promise<string> {
    return this.callApi(prompt);
  }

  private async callApi(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content.find((b) => b.type === 'text')?.text ?? '';
  }
}

function buildPrompt(input: NarrativeInput, ceiling: number): string {
  const evidenceLines = input.evidence
    .map(
      (e) =>
        `- [${e.id}] (${e.kind}) ${e.title}${e.excerpt ? `: ${e.excerpt}` : ''}`,
    )
    .join('\n');
  const causeLines = input.suspectedCauses
    .map((c) => `- ${c.label} (score: ${c.score})`)
    .join('\n');

  const hypothesisLines = input.hypotheses && input.hypotheses.length > 0
    ? input.hypotheses
        .map(
          (h) =>
            `- [${h.id}] (${h.category}) [deterministic: ${h.deterministicVerdict} @ ${h.deterministicConfidence.toFixed(2)}] ${h.statement}`,
        )
        .join('\n')
    : null;

  const hypothesisJudgmentSchema = hypothesisLines
    ? `  "hypothesisJudgments": [
    {
      "hypothesisId": "<id from hypotheses list above>",
      "category": "<category from hypotheses list>",
      "verdict": "<supported|weakened|eliminated|unconfirmed>",
      "rationale": "<one paragraph grounded in evidence IDs>",
      "citedEvidenceIds": ["<evidence IDs from the list>"],
      "confidence": <0–${ceiling}>
    }
  ],
  "rootCauseAssessment": {
    "summary": "<one paragraph root cause grounded in evidence>",
    "primaryHypothesisId": "<id of the hypothesis you consider the primary driver, or omit>",
    "citedEvidenceIds": ["<evidence IDs from the list>"],
    "uncertainty": "<low|medium|high>"
  },`
    : '';

  return `You are an incident analysis assistant. Analyze this investigation and return a JSON judgment.

Investigation hint: ${input.hint}
Deterministic summary: ${input.deterministicSummary}

Evidence (only cite IDs listed here):
${evidenceLines}

Suspected causes:
${causeLines}
${hypothesisLines ? `\nDeterministic hypotheses (provide a second-pass judgment for each):\n${hypothesisLines}` : ''}

Known services: ${input.knownServices.join(', ')}

Return ONLY valid JSON with this exact shape:
{
  "what": "<what happened — one concise paragraph>",
  "why": "<root cause narrative grounded in the evidence above>",
  "whereNext": ["<action 1>", "<action 2>"],
  "citations": [{"evidenceId": "<id from the evidence list>", "rationale": "<why this supports the claim>"}],
  "confidence": <number between 0 and ${ceiling}>,
  "mentionedServices": ["<service name from known list only>"],
${hypothesisJudgmentSchema}
}

Hard rules:
- confidence must not exceed ${ceiling}
- only cite evidence IDs from the list above — any other ID is a hallucination
- only include services from: ${input.knownServices.join(', ')}
- hypothesisJudgments must only reference hypothesis IDs from the hypotheses list above
- verdict must be exactly one of: supported, weakened, eliminated, unconfirmed
- uncertainty must be exactly one of: low, medium, high
- output raw JSON only: no markdown code fences, no text before or after the JSON`;
}

/**
 * Pull every balanced top-level `{…}` object out of a string by brace-counting
 * while respecting string literals and escapes (a greedy regex would over/under-match
 * when prose contains stray braces). Returned longest-first, since the real payload
 * is almost always the largest object — a tiny `{ note }` before it parses and is
 * skipped in favour of the full report.
 */
function sliceBalancedObjects(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) out.push(s.slice(start, i + 1));
      }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** Remove trailing commas before `}`/`]` — the most common model JSON defect. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Best-effort structured extraction from a model response (HOR-205). Tries, in order:
 * direct parse, fenced ```json block, first balanced object, and a trailing-comma
 * repair of each. Returns the parsed object, or null when nothing parses.
 */
export function extractJson(raw: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  candidates.push(trimmed);

  // Fenced code block: ```json … ``` or ``` … ```
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());

  // Balanced objects anywhere in the text (handles surrounding prose / stray braces).
  candidates.push(...sliceBalancedObjects(trimmed));

  for (const c of candidates) {
    for (const variant of [c, stripTrailingCommas(c)]) {
      try {
        const parsed = JSON.parse(variant);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        /* try the next candidate/variant */
      }
    }
  }
  return null;
}

/**
 * Build a NarrativeOutput from unparseable model text so a malformed JSON response
 * does not discard the AI narrative entirely (HOR-205). The raw prose becomes the
 * `why` narrative; citations/services are empty (nothing to validate against) and
 * confidence is capped, so it passes validation and reaches the user as degraded
 * AI output rather than silently falling back to the deterministic summary.
 */
function rawNarrativeFallback(raw: string, input: NarrativeInput, ceiling: number): NarrativeOutput {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  return {
    what: input.deterministicSummary || 'AI returned an unstructured response.',
    why: cleaned.slice(0, 4000),
    whereNext: [],
    citations: [],
    confidence: Math.min(input.reportConfidence, ceiling),
    degraded: true,
  };
}

function parseOutput(raw: string, input: NarrativeInput, ceiling: number): NarrativeOutput {
  const parsed = extractJson(raw);
  if (parsed === null) {
    // Could not recover structured JSON — preserve the raw narrative instead of
    // throwing (which would discard the entire AI response). Log enough to debug
    // without dumping the full text (which may echo user evidence).
    console.error(
      `[ai] structured JSON parse failed (response length ${raw.length}); ` +
        `preserving raw narrative fallback`,
    );
    return rawNarrativeFallback(raw, input, ceiling);
  }

  const confidence = Math.min(
    typeof parsed['confidence'] === 'number' ? parsed['confidence'] : input.reportConfidence,
    ceiling,
  );

  const citations: NarrativeCitation[] = Array.isArray(parsed['citations'])
    ? (parsed['citations'] as NarrativeCitation[])
    : [];

  const output: NarrativeOutput = {
    what: typeof parsed['what'] === 'string' ? parsed['what'] : '',
    why: typeof parsed['why'] === 'string' ? parsed['why'] : '',
    whereNext: Array.isArray(parsed['whereNext']) ? (parsed['whereNext'] as string[]).map(String) : [],
    citations,
    confidence,
  };

  if (Array.isArray(parsed['mentionedServices'])) {
    output.mentionedServices = (parsed['mentionedServices'] as unknown[]).map(String);
  }

  // Parse structured hypothesis judgments (HOR-197)
  if (Array.isArray(parsed['hypothesisJudgments'])) {
    output.hypothesisJudgments = (parsed['hypothesisJudgments'] as Record<string, unknown>[]).map(
      (j): AIHypothesisJudgment => ({
        hypothesisId: typeof j['hypothesisId'] === 'string' ? j['hypothesisId'] : '',
        category: typeof j['category'] === 'string' ? j['category'] : '',
        verdict: isValidVerdict(j['verdict']) ? j['verdict'] : 'unconfirmed',
        rationale: typeof j['rationale'] === 'string' ? j['rationale'] : '',
        citedEvidenceIds: Array.isArray(j['citedEvidenceIds'])
          ? (j['citedEvidenceIds'] as unknown[]).map(String)
          : [],
        confidence: Math.min(
          typeof j['confidence'] === 'number' ? j['confidence'] : 0,
          ceiling,
        ),
      }),
    );
  }

  // Parse structured root cause assessment (HOR-197)
  if (parsed['rootCauseAssessment'] && typeof parsed['rootCauseAssessment'] === 'object') {
    const rca = parsed['rootCauseAssessment'] as Record<string, unknown>;
    output.rootCauseAssessment = {
      summary: typeof rca['summary'] === 'string' ? rca['summary'] : '',
      primaryHypothesisId:
        typeof rca['primaryHypothesisId'] === 'string' ? rca['primaryHypothesisId'] : undefined,
      citedEvidenceIds: Array.isArray(rca['citedEvidenceIds'])
        ? (rca['citedEvidenceIds'] as unknown[]).map(String)
        : [],
      uncertainty: isValidUncertainty(rca['uncertainty']) ? rca['uncertainty'] : 'high',
    } satisfies AIRootCauseAssessment;
  }

  return output;
}

function isValidVerdict(v: unknown): v is AIHypothesisJudgment['verdict'] {
  return v === 'supported' || v === 'weakened' || v === 'eliminated' || v === 'unconfirmed';
}

function isValidUncertainty(v: unknown): v is AIRootCauseAssessment['uncertainty'] {
  return v === 'low' || v === 'medium' || v === 'high';
}
