/**
 * HOR-110 — v0.1 replay sample fixture tests.
 *
 * Exercises the full replay path on V01_REPLAY_SAMPLE:
 *   migrateReport → renderReport / reportToMarkdown / reportToJSON
 *
 * These tests are the regression guard: any packet shape change or render
 * pipeline regression that breaks replay will surface here first.
 *
 * All tests are deterministic — no I/O, no connectors, no live DB.
 */

import { describe, it, expect } from 'vitest';
import { V01_REPLAY_SAMPLE } from './replay-sample.js';
import { migrateReport } from './migrate-report.js';
import { renderReport, reportToMarkdown, reportToJSON } from './render.js';

// ---------------------------------------------------------------------------
// 1. Fixture shape
// ---------------------------------------------------------------------------

describe('V01_REPLAY_SAMPLE — fixture shape', () => {
  it('has the canonical v0.1 id', () => {
    expect(V01_REPLAY_SAMPLE.id).toBe('replay-sample-v01');
  });

  it('has nextActions (required since v0.1)', () => {
    expect(Array.isArray(V01_REPLAY_SAMPLE.nextActions)).toBe(true);
    expect(V01_REPLAY_SAMPLE.nextActions.length).toBeGreaterThan(0);
  });

  it('has gapAnalysis with at least one gap', () => {
    expect(V01_REPLAY_SAMPLE.gapAnalysis.gaps.length).toBeGreaterThan(0);
  });

  it('evidence IDs referenced in findings exist in the evidence array', () => {
    const ids = new Set(V01_REPLAY_SAMPLE.evidence.map((e) => e.id));
    for (const f of V01_REPLAY_SAMPLE.findings) {
      for (const eid of f.evidenceIds) {
        expect(ids.has(eid), `finding "${f.title}" references unknown evidenceId "${eid}"`).toBe(true);
      }
    }
  });

  it('suspectedCause sourceEvidenceIds reference existing evidence', () => {
    const ids = new Set(V01_REPLAY_SAMPLE.evidence.map((e) => e.id));
    for (const cause of V01_REPLAY_SAMPLE.suspectedCauses) {
      for (const eid of cause.sourceEvidenceIds) {
        expect(ids.has(eid), `cause references unknown evidenceId "${eid}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. migrateReport — idempotency
// ---------------------------------------------------------------------------

describe('V01_REPLAY_SAMPLE — migrateReport', () => {
  it('is idempotent on already-normalised v0.1 packet', () => {
    const once = migrateReport(V01_REPLAY_SAMPLE);
    const twice = migrateReport(once);
    expect(twice.id).toBe(V01_REPLAY_SAMPLE.id);
    expect(twice.nextActions).toEqual(once.nextActions);
    expect(twice.suspectedCauses[0]?.title).toBe(once.suspectedCauses[0]?.title);
  });

  it('preserves nextActions through migration', () => {
    const migrated = migrateReport(V01_REPLAY_SAMPLE);
    expect(migrated.nextActions).toEqual(V01_REPLAY_SAMPLE.nextActions);
  });

  it('preserves suspectedCause finalScore through migration', () => {
    const migrated = migrateReport(V01_REPLAY_SAMPLE);
    expect(migrated.suspectedCauses[0]?.finalScore).toBe(V01_REPLAY_SAMPLE.suspectedCauses[0]?.finalScore);
  });
});

// ---------------------------------------------------------------------------
// 3. renderReport — terminal text output
// ---------------------------------------------------------------------------

describe('V01_REPLAY_SAMPLE — renderReport', () => {
  const report = migrateReport(V01_REPLAY_SAMPLE);
  let output: string;

  it('does not throw', () => {
    expect(() => { output = renderReport(report); }).not.toThrow();
    output = renderReport(report);
  });

  it('includes the hint in the header', () => {
    expect(renderReport(report)).toContain('payment-gateway timeouts after deploy');
  });

  it('includes ## Summary section', () => {
    expect(renderReport(report)).toContain('## Summary');
  });

  it('includes ## Suspected causes section with the cause title', () => {
    const out = renderReport(report);
    expect(out).toContain('## Suspected causes (ranked)');
    expect(out).toContain('Gateway timeout increase caused cascading payment delays');
  });

  it('includes ## Evidence gaps section', () => {
    expect(renderReport(report)).toContain("## Evidence gaps (what we don't know)");
  });

  it('includes ## Next actions section', () => {
    const out = renderReport(report);
    expect(out).toContain('## Next actions');
    expect(out).toContain('src/gateway/client.ts');
  });

  it('includes ## Why confidence is not higher section (confidence 0.62 < 0.80)', () => {
    expect(renderReport(report)).toContain('## Why confidence is not higher');
  });

  it('includes the confidence value', () => {
    expect(renderReport(report)).toContain('0.62');
  });
});

// ---------------------------------------------------------------------------
// 4. reportToMarkdown — shareable markdown output
// ---------------------------------------------------------------------------

describe('V01_REPLAY_SAMPLE — reportToMarkdown', () => {
  const report = migrateReport(V01_REPLAY_SAMPLE);

  it('does not throw', () => {
    expect(() => reportToMarkdown(report)).not.toThrow();
  });

  it('includes the hint in the title', () => {
    expect(reportToMarkdown(report)).toContain('payment-gateway timeouts after deploy');
  });

  it('includes **Confidence:** field', () => {
    expect(reportToMarkdown(report)).toContain('**Confidence:**');
  });

  it('includes ## Suspected causes section', () => {
    expect(reportToMarkdown(report)).toContain('## Suspected causes');
  });

  it('includes ## Evidence gaps section', () => {
    expect(reportToMarkdown(report)).toContain("## Evidence gaps (what we don't know)");
  });

  it('renders next actions as checkboxes', () => {
    expect(reportToMarkdown(report)).toContain('- [ ]');
  });

  it('includes ## Why confidence is not higher section', () => {
    expect(reportToMarkdown(report)).toContain('## Why confidence is not higher');
  });

  it('ends with generated-by footer', () => {
    expect(reportToMarkdown(report)).toContain('Generated by Horus');
  });
});

// ---------------------------------------------------------------------------
// 5. reportToJSON — serialized round-trip
// ---------------------------------------------------------------------------

describe('V01_REPLAY_SAMPLE — reportToJSON', () => {
  const report = migrateReport(V01_REPLAY_SAMPLE);

  it('does not throw', () => {
    expect(() => reportToJSON(report)).not.toThrow();
  });

  it('produces valid JSON', () => {
    expect(() => JSON.parse(reportToJSON(report))).not.toThrow();
  });

  it('JSON round-trip preserves id', () => {
    const parsed = JSON.parse(reportToJSON(report)) as { id: string };
    expect(parsed.id).toBe('replay-sample-v01');
  });

  it('JSON round-trip preserves nextActions array', () => {
    const parsed = JSON.parse(reportToJSON(report)) as { nextActions: string[] };
    expect(Array.isArray(parsed.nextActions)).toBe(true);
    expect(parsed.nextActions.length).toBeGreaterThan(0);
  });

  it('JSON round-trip preserves gapAnalysis', () => {
    const parsed = JSON.parse(reportToJSON(report)) as { gapAnalysis: { gaps: unknown[] } };
    expect(parsed.gapAnalysis.gaps.length).toBeGreaterThan(0);
  });
});
