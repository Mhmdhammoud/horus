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

import { redactNarrativeInput } from './redact.js';

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

/** A deterministic hypothesis passed to the AI for second-pass judgment (HOR-197). */
export interface NarrativeHypothesisItem {
  id: string;
  category: string;
  statement: string;
  /** Deterministic engine verdict before AI judgment. */
  deterministicVerdict: 'supported' | 'weakened' | 'eliminated' | 'unconfirmed';
  /** Deterministic engine confidence (0–1). */
  deterministicConfidence: number;
  /** Evidence IDs that support this hypothesis deterministically. */
  supportingEvidenceIds: string[];
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
  /** Deterministic hypotheses for AI second-pass judgment (HOR-197). */
  hypotheses?: NarrativeHypothesisItem[];
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

/**
 * AI second-pass judgment on a single deterministic hypothesis (HOR-197).
 * The AI may agree with, refine, or disagree with the deterministic verdict.
 * Deterministic scoring remains authoritative; this is an annotation layer.
 */
export interface AIHypothesisJudgment {
  hypothesisId: string;
  category: string;
  verdict: 'supported' | 'weakened' | 'eliminated' | 'unconfirmed';
  /** One-paragraph rationale grounded in cited evidence. */
  rationale: string;
  /** Evidence IDs the AI cites to support this verdict. Must be from NarrativeInput.evidence. */
  citedEvidenceIds: string[];
  /** AI confidence in this verdict (0–1). Must not exceed reportConfidence. */
  confidence: number;
}

/**
 * AI structured root cause assessment (HOR-197).
 * Complements the deterministic suspected causes with an evidence-grounded narrative.
 */
export interface AIRootCauseAssessment {
  /** One-paragraph root cause summary grounded in cited evidence. */
  summary: string;
  /** ID of the hypothesis the AI considers the primary cause driver, if any. */
  primaryHypothesisId?: string;
  /** Evidence IDs cited in this root cause assessment. */
  citedEvidenceIds: string[];
  /** AI-reported uncertainty level based on evidence quality. */
  uncertainty: 'low' | 'medium' | 'high';
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
  /**
   * Structured per-hypothesis AI judgments (HOR-197).
   * Present when input.hypotheses was supplied. AI verdict and rationale for each hypothesis.
   */
  hypothesisJudgments?: AIHypothesisJudgment[];
  /**
   * Structured AI root cause assessment (HOR-197).
   * Complements the deterministic suspected causes; never replaces them.
   */
  rootCauseAssessment?: AIRootCauseAssessment;
  /**
   * True when this narrative could not be parsed as structured JSON and `why` holds the
   * raw model prose (HOR-205/213). The renderer labels it as unstructured AI output.
   */
  degraded?: boolean;
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
  // whereNext is recommended-actions context, not core narrative. A missing or empty
  // list must NOT invalidate an otherwise-useful narrative (HOR-213) — default it to [].
  if (!Array.isArray(output.whereNext)) {
    output.whereNext = [];
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

  // Hypothesis judgment validation (HOR-197)
  if (output.hypothesisJudgments !== undefined) {
    const knownHypIds = new Set(input.hypotheses?.map((h) => h.id) ?? []);
    const validVerdicts = new Set(['supported', 'weakened', 'eliminated', 'unconfirmed']);
    for (const j of output.hypothesisJudgments) {
      if (input.hypotheses && !knownHypIds.has(j.hypothesisId)) {
        errors.push(
          `hypothesisJudgment references unknown hypothesis ID "${j.hypothesisId}"`,
        );
      }
      if (!validVerdicts.has(j.verdict)) {
        errors.push(
          `hypothesisJudgment "${j.hypothesisId}" has invalid verdict "${j.verdict}"`,
        );
      }
      if (!j.rationale || j.rationale.trim().length === 0) {
        errors.push(`hypothesisJudgment "${j.hypothesisId}" has empty rationale`);
      }
      for (const eid of j.citedEvidenceIds) {
        if (!knownIds.has(eid)) {
          errors.push(
            `hypothesisJudgment "${j.hypothesisId}" cites unknown evidence ID "${eid}"`,
          );
        }
      }
      if (j.confidence < 0 || j.confidence > 1) {
        errors.push(
          `hypothesisJudgment "${j.hypothesisId}" confidence must be between 0 and 1`,
        );
      }
    }
  }

  // Root cause assessment validation (HOR-197)
  if (output.rootCauseAssessment !== undefined) {
    const rca = output.rootCauseAssessment;
    if (!rca.summary || rca.summary.trim().length === 0) {
      errors.push('rootCauseAssessment.summary must be non-empty');
    }
    for (const eid of rca.citedEvidenceIds) {
      if (!knownIds.has(eid)) {
        errors.push(`rootCauseAssessment cites unknown evidence ID "${eid}"`);
      }
    }
    const validUncertainty = new Set(['low', 'medium', 'high']);
    if (!validUncertainty.has(rca.uncertainty)) {
      errors.push(
        `rootCauseAssessment.uncertainty must be 'low', 'medium', or 'high' (got "${rca.uncertainty}")`,
      );
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
  /**
   * True when the provider produced usable narrative text that did not fully validate
   * (or was unstructured) — render it as a labeled raw AI section rather than discarding
   * it for the deterministic summary (HOR-213).
   */
  degraded?: boolean;
  /** Validation errors from provider output, if any. */
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
    // Redact sensitive values from the packet before it reaches the provider.
    const safeInput = redactNarrativeInput(input);
    try {
      const output = await opts.provider.render(safeInput, { confidenceCeiling: ceiling });
      const validation = validateNarrative(output, safeInput);
      if (validation.valid && output.degraded !== true) {
        return { output, fromProvider: true };
      }
      // Not fully structured-valid (e.g. a hallucinated citation) OR an unstructured raw
      // narrative — but the model still produced usable prose. Surface it as a labeled
      // degraded section instead of discarding it for the deterministic summary (HOR-213).
      const hasText = (output.what?.trim()?.length ?? 0) > 0 || (output.why?.trim()?.length ?? 0) > 0;
      if (hasText) {
        // Carry ONLY the narrative prose to the degraded result. The structured fields
        // (citations, mentionedServices, hypothesisJudgments, rootCauseAssessment) did not
        // fully validate, so they are dropped — nothing downstream can mistake an
        // unvalidated/hallucinated cause or over-ceiling confidence for a trusted one.
        const degradedOutput: NarrativeOutput = {
          what: output.what ?? '',
          why: output.why ?? '',
          whereNext: Array.isArray(output.whereNext) ? output.whereNext : [],
          citations: [],
          confidence: Math.min(output.confidence ?? input.reportConfidence, ceiling),
          degraded: true,
        };
        return {
          output: degradedOutput,
          fromProvider: false,
          degraded: true,
          validationErrors: validation.errors,
        };
      }
      return {
        output: deterministicFallback(input),
        fromProvider: false,
        validationErrors: validation.errors,
      };
    } catch (err) {
      return {
        output: deterministicFallback(input),
        fromProvider: false,
        validationErrors: [err instanceof Error ? err.message : 'Provider threw an error'],
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

