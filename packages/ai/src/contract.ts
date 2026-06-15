/**
 * HOR-51 — AI narrative contract and citation validator.
 *
 * Defines the data boundary between Horus's deterministic investigation engine
 * and any AI narrative provider. The contract enforces:
 *
 *   1. AI receives only a bounded, structured packet (no raw logs, no live queries).
 *   2. AI output is validated before it touches the report (citation + confidence guard).
 *   3. Provider failure falls back to a deterministic summary automatically.
 *
 * AI never replaces deterministic scoring. It only annotates it.
 * The caller (CLI / engine layer) builds the NarrativeInput from the full report —
 * @horus/ai stays decoupled from @horus/engine.
 */

// ---------------------------------------------------------------------------
// Input packet — what the AI provider receives
// ---------------------------------------------------------------------------

/** A single evidence item in the narrative input packet. */
export interface NarrativeEvidenceItem {
  id: string;
  kind: string;
  title: string;
  service?: string;
  /** Brief structured excerpt only — never raw unbounded log lines. */
  excerpt?: string;
}

/** A suspected cause in the narrative input packet. */
export interface NarrativeCauseItem {
  label: string;
  score: number;
  evidenceIds: string[];
}

/**
 * Bounded, sanitised packet passed to a NarrativeProvider.
 * All evidence IDs here are the only valid citation targets.
 */
export interface NarrativeInput {
  /** Unique investigation ID. */
  investigationId: string;
  /** The original user hint. */
  hint: string;
  /** Deterministic confidence ceiling from the investigation engine (0–1). */
  reportConfidence: number;
  /** All evidence items available for citation. */
  evidence: NarrativeEvidenceItem[];
  /** Services mentioned in the evidence (for hallucination detection). */
  knownServices: string[];
  /** Top suspected causes from the deterministic engine. */
  suspectedCauses: NarrativeCauseItem[];
  /** Deterministic summary from the engine (provider can enhance, not replace). */
  deterministicSummary: string;
  /** Key findings from the engine for context. */
  findings: Array<{ title: string; evidenceIds: string[] }>;
}

// ---------------------------------------------------------------------------
// Output — what the AI provider returns
// ---------------------------------------------------------------------------

/** A single citation in the narrative output. */
export interface NarrativeCitation {
  evidenceId: string;
  /** Why this evidence supports the claim. */
  rationale?: string;
}

/** The structured output a NarrativeProvider must return. */
export interface NarrativeOutput {
  /** What happened — a human-readable summary grounded in evidence. */
  what: string;
  /** Why it happened — root cause narrative grounded in evidence. */
  why: string;
  /** Recommended next actions. */
  whereNext: string[];
  /** All evidence IDs cited in the narrative. Must be a subset of NarrativeInput.evidence IDs. */
  citations: NarrativeCitation[];
  /** Provider-reported confidence (0–1). Must not exceed reportConfidence. */
  confidence: number;
  /** Optional: services the narrative mentions. Used for hallucination check. */
  mentionedServices?: string[];
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface NarrativeProviderOptions {
  /** Hard ceiling on confidence the provider may claim. Defaults to input.reportConfidence. */
  confidenceCeiling?: number;
}

/** Contract all AI narrative providers must implement. */
export interface NarrativeProvider {
  readonly name: string;
  render(input: NarrativeInput, opts?: NarrativeProviderOptions): Promise<NarrativeOutput>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface NarrativeValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a NarrativeOutput against the NarrativeInput it was derived from.
 * Enforces:
 *   - all cited evidence IDs exist in the input
 *   - confidence does not exceed reportConfidence
 *   - no new services are introduced that are not in knownServices
 *   - required sections (what, why, whereNext) are non-empty strings
 */
export function validateNarrative(
  output: NarrativeOutput,
  input: NarrativeInput,
): NarrativeValidationResult {
  const errors: string[] = [];
  const knownIds = new Set(input.evidence.map((e) => e.id));
  const knownServices = new Set(input.knownServices.map((s) => s.toLowerCase()));

  // Required sections
  if (!output.what || output.what.trim().length === 0) {
    errors.push('NarrativeOutput.what is required and must be non-empty');
  }
  if (!output.why || output.why.trim().length === 0) {
    errors.push('NarrativeOutput.why is required and must be non-empty');
  }
  if (!Array.isArray(output.whereNext) || output.whereNext.length === 0) {
    errors.push('NarrativeOutput.whereNext must be a non-empty array');
  }

  // Citation check — unknown IDs rejected
  for (const citation of output.citations) {
    if (!knownIds.has(citation.evidenceId)) {
      errors.push(
        `Citation references unknown evidence ID "${citation.evidenceId}" — hallucinated citation`,
      );
    }
  }

  // Confidence guard — cannot exceed deterministic ceiling
  if (output.confidence > input.reportConfidence + 0.001) {
    errors.push(
      `NarrativeOutput.confidence (${output.confidence}) exceeds reportConfidence ceiling (${input.reportConfidence})`,
    );
  }
  if (output.confidence < 0 || output.confidence > 1) {
    errors.push(`NarrativeOutput.confidence must be between 0 and 1 (got ${output.confidence})`);
  }

  // Service hallucination check — only when provider declares mentionedServices
  if (output.mentionedServices) {
    for (const svc of output.mentionedServices) {
      if (!knownServices.has(svc.toLowerCase())) {
        errors.push(
          `Narrative mentions service "${svc}" which is not in the known services list — possible hallucination`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// renderNarrative — orchestrator with fallback
// ---------------------------------------------------------------------------

export interface RenderNarrativeOptions {
  provider?: NarrativeProvider;
  /** Override confidence ceiling passed to the provider. Defaults to input.reportConfidence. */
  confidenceCeiling?: number;
}

export interface RenderNarrativeResult {
  output: NarrativeOutput;
  /** True when the provider was used and output passed validation. */
  fromProvider: boolean;
  /** Validation errors from provider output, if any (triggers fallback). */
  validationErrors?: string[];
}

/**
 * Render a narrative for an investigation.
 *
 * If a provider is given, calls it and validates the output. On provider error
 * or validation failure, silently falls back to a deterministic narrative so the
 * investigation report is never blocked by AI unavailability.
 */
export async function renderNarrative(
  input: NarrativeInput,
  opts: RenderNarrativeOptions = {},
): Promise<RenderNarrativeResult> {
  const ceiling = opts.confidenceCeiling ?? input.reportConfidence;

  if (opts.provider) {
    try {
      const output = await opts.provider.render(input, { confidenceCeiling: ceiling });
      const validation = validateNarrative(output, input);
      if (validation.valid) {
        return { output, fromProvider: true };
      }
      return {
        output: deterministicFallback(input),
        fromProvider: false,
        validationErrors: validation.errors,
      };
    } catch {
      return {
        output: deterministicFallback(input),
        fromProvider: false,
        validationErrors: ['Provider threw an error'],
      };
    }
  }

  return { output: deterministicFallback(input), fromProvider: false };
}

/** Build a deterministic narrative from the investigation packet alone. */
function deterministicFallback(input: NarrativeInput): NarrativeOutput {
  const topCause = input.suspectedCauses[0];
  const what = input.deterministicSummary;
  const why = topCause
    ? `Most likely cause: ${topCause.label} (score ${(topCause.score * 100).toFixed(0)}%).`
    : 'Root cause could not be determined from available evidence.';
  const whereNext =
    input.findings.length > 0
      ? [`Investigate: ${input.findings[0]!.title}`]
      : ['Collect more evidence and re-run investigation.'];

  return {
    what,
    why,
    whereNext,
    citations: [],
    confidence: input.reportConfidence,
  };
}

