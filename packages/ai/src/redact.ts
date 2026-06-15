/**
 * HOR-72 — Narrative input redaction guard.
 *
 * Scans free-text fields in a NarrativeInput for obvious secret patterns
 * (URL-embedded credentials, key=value pairs, Bearer tokens, AWS keys) and
 * replaces their values with `[REDACTED]` before the packet reaches any AI
 * provider. This is a lightweight guard, not a full DLP engine.
 *
 * Invariants:
 *   - Keys / field names are preserved so the narrative stays useful.
 *   - All other (non-text) fields are copied unchanged.
 *   - The input object is never mutated; a new object is returned.
 */

import type { NarrativeInput } from './contract.js';

// ---------------------------------------------------------------------------
// Patterns — ordered from most specific to least
// ---------------------------------------------------------------------------

const REDACT_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // URL-embedded credentials: http(s)://user:pass@host
  {
    pattern: /(https?:\/\/)[^:@\s]+:[^@\s]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  // Database / service connection strings with embedded credentials
  {
    pattern: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/)[^:@\s]+:[^@\s]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  // AWS Access Key IDs
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: '[REDACTED]',
  },
  // Bearer tokens
  {
    pattern: /\bBearer\s+[A-Za-z0-9._\-]{8,}/g,
    replacement: 'Bearer [REDACTED]',
  },
  // Cookie / set-cookie header values
  {
    pattern: /((?:cookie|set-cookie)\s*[=:]\s*)[^\s"',;>]{4,}/gi,
    replacement: '$1[REDACTED]',
  },
  // key=value / key: value for common credential field names
  // Captures: password, passwd, pwd, token, api_key, apikey, secret, credential
  // Note: "auth" / "authorization" is intentionally excluded — Bearer pattern handles those.
  {
    pattern:
      /\b(password|passwd|pwd|token|api[_-]?key|secret|credential)[=:\s]+["']?[A-Za-z0-9._\-+/=@!#$%^&*]{4,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },
];

/** Apply all redaction rules to a single string. Returns the sanitised string. */
export function redactString(s: string): string {
  let result = s;
  for (const rule of REDACT_RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Return a new NarrativeInput with sensitive values redacted from all free-text
 * fields. Structural fields (IDs, scores, enums, arrays of IDs) are copied as-is.
 */
export function redactNarrativeInput(input: NarrativeInput): NarrativeInput {
  return {
    ...input,
    hint: redactString(input.hint),
    deterministicSummary: redactString(input.deterministicSummary),
    evidence: input.evidence.map((e) => ({
      ...e,
      title: redactString(e.title),
      excerpt: e.excerpt !== undefined ? redactString(e.excerpt) : undefined,
    })),
    suspectedCauses: input.suspectedCauses.map((c) => ({
      ...c,
      label: redactString(c.label),
    })),
    findings: input.findings.map((f) => ({
      ...f,
      title: redactString(f.title),
    })),
  };
}
