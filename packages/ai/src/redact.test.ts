/**
 * HOR-72 — Narrative input redaction guard tests.
 *
 * All fixtures use fake/synthetic values.
 * No real credentials are committed here.
 */

import { describe, it, expect } from 'vitest';
import { redactString, redactNarrativeInput } from './redact.js';
import { FIXTURE_INPUT } from './fixtures.js';

// ---------------------------------------------------------------------------
// redactString — individual pattern tests
// ---------------------------------------------------------------------------

describe('redactString — URL-embedded credentials', () => {
  it('redacts http basic-auth credentials', () => {
    expect(redactString('connecting to http://admin:s3cr3t@db.internal:5432')).toBe(
      'connecting to http://[REDACTED]@db.internal:5432',
    );
  });

  it('redacts https basic-auth credentials', () => {
    expect(redactString('https://elastic:password123@es-host:9200/_search')).toBe(
      'https://[REDACTED]@es-host:9200/_search',
    );
  });

  it('leaves URLs without credentials unchanged', () => {
    const url = 'https://es-host:9200/_search';
    expect(redactString(url)).toBe(url);
  });
});

describe('redactString — AWS access keys', () => {
  it('redacts AWS access key ID (AKIA…)', () => {
    expect(redactString('key=AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redactString('AKIAIOSFODNN7EXAMPLE present')).toBe('[REDACTED] present');
  });
});

describe('redactString — Bearer tokens', () => {
  it('redacts Bearer token value', () => {
    const result = redactString('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload');
    expect(result).toBe('Authorization: Bearer [REDACTED]');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  it('leaves short Bearer values below 8 chars unchanged', () => {
    // Anything under 8 chars is unlikely to be a real token — leave it
    expect(redactString('Bearer abc')).toBe('Bearer abc');
  });
});

describe('redactString — key=value credential patterns', () => {
  it('redacts password= patterns', () => {
    const result = redactString('error connecting: password=hunter2 rejected');
    expect(result).toContain('password=[REDACTED]');
    expect(result).not.toContain('hunter2');
  });

  it('redacts token= patterns', () => {
    const result = redactString('token=ghp_abcdefABCDEF1234567890abcdefABCD');
    expect(result).toContain('token=[REDACTED]');
    expect(result).not.toContain('ghp_abcdefABCDEF1234567890abcdefABCD');
  });

  it('redacts secret= patterns', () => {
    const result = redactString('secret=abc123XYZ_value in config');
    expect(result).toContain('secret=[REDACTED]');
    expect(result).not.toContain('abc123XYZ_value');
  });

  it('redacts api_key= patterns', () => {
    const result = redactString('api_key=sk-abcdefghijklmnop');
    expect(result).toContain('api_key=[REDACTED]');
    expect(result).not.toContain('sk-abcdefghijklmnop');
  });

  it('preserves the key name in redacted output', () => {
    const result = redactString('password=s3cr3t');
    expect(result).toContain('password=');
  });
});

describe('redactString — benign strings', () => {
  it('leaves ordinary log messages unchanged', () => {
    const msg = 'Job id=42 stalled after 30000ms — queue depth 1200';
    expect(redactString(msg)).toBe(msg);
  });

  it('leaves service names unchanged', () => {
    expect(redactString('leadcall-api')).toBe('leadcall-api');
  });

  it('leaves empty string unchanged', () => {
    expect(redactString('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// redactNarrativeInput — structural tests
// ---------------------------------------------------------------------------

describe('redactNarrativeInput — field coverage', () => {
  const INPUT_WITH_SECRETS = {
    ...FIXTURE_INPUT,
    hint: 'investigate https://admin:s3cr3t@db.internal failure',
    deterministicSummary: 'Workers failed: password=hunter2 caused rejection',
    evidence: [
      {
        id: 'ev-001',
        kind: 'log' as const,
        title: 'Connection error: token=ghp_abcdefABCDEF1234567890abcdefABCD',
        excerpt: 'Bearer eyJhbGciOiJSUzI1NiJ9.payload received',
      },
    ],
    suspectedCauses: [
      {
        label: 'Auth failure: password=hunter2 in config',
        score: 0.8,
        evidenceIds: ['ev-001'],
      },
    ],
    findings: [
      {
        title: 'token=secret_value found in logs',
        evidenceIds: ['ev-001'],
      },
    ],
  };

  it('does not mutate the original input', () => {
    const original = { ...INPUT_WITH_SECRETS };
    redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(INPUT_WITH_SECRETS.hint).toBe(original.hint);
    expect(INPUT_WITH_SECRETS.deterministicSummary).toBe(original.deterministicSummary);
  });

  it('redacts hint', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.hint).not.toContain('s3cr3t');
    expect(result.hint).toContain('[REDACTED]');
  });

  it('redacts deterministicSummary', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.deterministicSummary).not.toContain('hunter2');
    expect(result.deterministicSummary).toContain('[REDACTED]');
  });

  it('redacts evidence[].title', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.evidence[0]?.title).not.toContain('ghp_abcdefABCDEF1234567890abcdefABCD');
    expect(result.evidence[0]?.title).toContain('[REDACTED]');
  });

  it('redacts evidence[].excerpt', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.evidence[0]?.excerpt).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result.evidence[0]?.excerpt).toContain('[REDACTED]');
  });

  it('redacts suspectedCauses[].label', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.suspectedCauses[0]?.label).not.toContain('hunter2');
    expect(result.suspectedCauses[0]?.label).toContain('[REDACTED]');
  });

  it('redacts findings[].title', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.findings[0]?.title).not.toContain('secret_value');
    expect(result.findings[0]?.title).toContain('[REDACTED]');
  });

  it('preserves evidence IDs unchanged', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.evidence[0]?.id).toBe('ev-001');
  });

  it('preserves evidence kind unchanged', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.evidence[0]?.kind).toBe('log');
  });

  it('preserves investigationId unchanged', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.investigationId).toBe(FIXTURE_INPUT.investigationId);
  });

  it('preserves reportConfidence unchanged', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.reportConfidence).toBe(FIXTURE_INPUT.reportConfidence);
  });

  it('preserves knownServices unchanged', () => {
    const result = redactNarrativeInput(INPUT_WITH_SECRETS);
    expect(result.knownServices).toEqual(FIXTURE_INPUT.knownServices);
  });

  it('leaves clean FIXTURE_INPUT unchanged', () => {
    const result = redactNarrativeInput(FIXTURE_INPUT);
    expect(result.hint).toBe(FIXTURE_INPUT.hint);
    expect(result.deterministicSummary).toBe(FIXTURE_INPUT.deterministicSummary);
    for (let i = 0; i < FIXTURE_INPUT.evidence.length; i++) {
      expect(result.evidence[i]?.title).toBe(FIXTURE_INPUT.evidence[i]?.title);
    }
  });
});
