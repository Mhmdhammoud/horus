/**
 * Unit tests for the read-only accuracy harness (HOR-403).
 *
 * Coverage:
 *   • dedupe-to-current-verdict matches `summarizeOutcomeLabels` on shared fixtures;
 *   • validate-on-read quarantines bad resolved/source (counted, excluded);
 *   • null-investigation + unparseable/legacy report → unjoinable (counted, excluded);
 *   • BaselineReport math == summarizeOutcomeLabels;
 *   • determinism (same inputs → byte-identical corpus);
 *   • confirm rows are positive-only/weak + their confirmedCause is never a target;
 *   • feature-separation is a no-model yes-vs-no contrast.
 */
import { describe, it, expect } from 'vitest';
import {
  summarizeOutcomeLabels,
  dedupeToCurrentVerdict,
  type OutcomeLabel,
} from '@horus/db';
import { buildCorpus, serializeCorpus, type ReportResolver } from './corpus.js';
import { computeBaseline, featureSeparation } from './baseline.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

let idCounter = 0;
function label(p: Partial<OutcomeLabel> & { investigationId: string | null }): OutcomeLabel {
  idCounter += 1;
  return {
    id: p.id ?? `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`,
    investigationId: p.investigationId,
    project: p.project ?? 'demo',
    resolved: p.resolved ?? 'yes',
    confirmedCause: p.confirmedCause ?? null,
    note: p.note ?? null,
    source: p.source ?? 'feedback',
    payload: p.payload ?? null,
    at: p.at ?? new Date('2026-06-01T00:00:00.000Z'),
  } as OutcomeLabel;
}

function report(opts: {
  summary?: string;
  confidence?: number;
  seeds?: string[];
  causes?: Array<{
    id: string;
    category?: string;
    finalScore: number;
    confidence?: number;
    band?: string;
    sourceEvidenceIds?: string[];
    factors?: Array<{ factor: string; delta: number }>;
  }>;
}): unknown {
  return {
    summary: opts.summary ?? 'something broke',
    confidence: opts.confidence ?? 0.7,
    seeds: (opts.seeds ?? ['PaymentService']).map((name) => ({ id: name, name, filePath: 'a.ts' })),
    suspectedCauses: (opts.causes ?? []).map((c) => ({
      id: c.id,
      title: c.id,
      category: c.category ?? 'generic',
      sourceEvidenceIds: c.sourceEvidenceIds ?? [],
      affectedNodeIds: [],
      baseScore: c.finalScore,
      finalScore: c.finalScore,
      confidence: c.confidence ?? c.finalScore,
      band: c.band ?? 'possible',
      explanations: (c.factors ?? []).map((f) => ({ factor: f.factor, delta: f.delta, reason: f.factor })),
    })),
  };
}

/** A resolver over a fixed map; unknown ids resolve to null (missing report). */
function resolverFor(map: Record<string, unknown>): ReportResolver {
  return (id: string) => (id in map ? map[id] : null);
}

// ── dedupe parity ─────────────────────────────────────────────────────────

describe('dedupe-to-current-verdict parity with summarizeOutcomeLabels', () => {
  it('the corpus dedupes to the SAME current verdict per investigation', () => {
    // Two attestations for inv-a (no wins, latest), one for inv-b. Shuffled order.
    const labels = [
      label({ investigationId: 'inv-a', resolved: 'yes', at: new Date('2026-06-01T00:00:00Z') }),
      label({ investigationId: 'inv-b', resolved: 'partly', at: new Date('2026-06-02T00:00:00Z') }),
      label({ investigationId: 'inv-a', resolved: 'no', at: new Date('2026-06-03T00:00:00Z') }),
    ];
    const reports = resolverFor({
      'inv-a': report({ causes: [{ id: 'c1', finalScore: 0.8 }] }),
      'inv-b': report({ causes: [{ id: 'c1', finalScore: 0.6 }] }),
    });
    const build = buildCorpus(labels, reports);

    // Same set of current verdicts as the shared dedupe + summarize.
    const current = dedupeToCurrentVerdict(labels);
    expect(build.evaluated).toBe(current.length);
    const corpusVerdicts = Object.fromEntries(build.rows.map((r) => [r.investigationId, r.target]));
    expect(corpusVerdicts).toEqual({ 'inv-a': 'no', 'inv-b': 'partly' });

    const summary = summarizeOutcomeLabels(labels);
    expect(build.classBalance).toEqual({ yes: summary.counts.yes, partly: summary.counts.partly, no: summary.counts.no });
  });

  it('tie on `at` is broken by greater id (matches summarizeOutcomeLabels)', () => {
    const at = new Date('2026-06-01T00:00:00Z');
    const lo = label({ id: 'aaaa', investigationId: 'inv-a', resolved: 'yes', at });
    const hi = label({ id: 'zzzz', investigationId: 'inv-a', resolved: 'no', at });
    const reports = resolverFor({ 'inv-a': report({ causes: [{ id: 'c1', finalScore: 0.5 }] }) });
    const build = buildCorpus([lo, hi], reports);
    expect(build.rows).toHaveLength(1);
    expect(build.rows[0]!.target).toBe('no'); // greater id wins the tie
  });
});

// ── validate-on-read firewall ───────────────────────────────────────────────

describe('validate-on-read firewall', () => {
  it('quarantines bad resolved/source (counted, excluded from rows)', () => {
    const labels = [
      label({ investigationId: 'good', resolved: 'yes', source: 'feedback' }),
      label({ investigationId: 'bad-resolved', resolved: 'maybe' as OutcomeLabel['resolved'] }),
      label({ investigationId: 'bad-source', source: 'prompt' as OutcomeLabel['source'] }),
    ];
    const reports = resolverFor({
      good: report({ causes: [{ id: 'c1', finalScore: 0.5 }] }),
      'bad-resolved': report({ causes: [] }),
      'bad-source': report({ causes: [] }),
    });
    const build = buildCorpus(labels, reports);
    expect(build.rows.map((r) => r.investigationId)).toEqual(['good']);
    expect(build.quarantined).toHaveLength(2);
    expect(build.evaluated).toBe(3); // all three are still current verdicts (counted)
  });
});

// ── unjoinable ──────────────────────────────────────────────────────────────

describe('unjoinable rows (null investigation + missing/legacy report)', () => {
  it('drops null-investigationId labels as unjoinable (counted)', () => {
    const labels = [label({ investigationId: null, resolved: 'yes' })];
    const build = buildCorpus(labels, resolverFor({}));
    expect(build.rows).toHaveLength(0);
    expect(build.unjoinable).toEqual([{ investigationId: null, reason: 'null-investigation' }]);
    expect(build.evaluated).toBe(1);
  });

  it('drops missing and legacy/unparseable reports as unjoinable (counted)', () => {
    const labels = [
      label({ investigationId: 'missing', resolved: 'yes' }),
      label({ investigationId: 'legacy', resolved: 'no' }),
      label({ investigationId: 'ok', resolved: 'yes' }),
    ];
    const reports = resolverFor({
      // 'missing' absent → null report
      legacy: { summary: 'old', confidence: 0.5 }, // no suspectedCauses array → legacy
      ok: report({ causes: [{ id: 'c1', finalScore: 0.5 }] }),
    });
    const build = buildCorpus(labels, reports);
    expect(build.rows.map((r) => r.investigationId)).toEqual(['ok']);
    const reasons = build.unjoinable.map((u) => `${u.investigationId}:${u.reason}`).sort();
    expect(reasons).toEqual(['legacy:legacy-report', 'missing:missing-report']);
  });

  it('an empty suspectedCauses report is VALID (headlineCause null, joins)', () => {
    const labels = [label({ investigationId: 'inv', resolved: 'yes' })];
    const build = buildCorpus(labels, resolverFor({ inv: report({ causes: [] }) }));
    expect(build.rows).toHaveLength(1);
    expect(build.rows[0]!.headlineCause).toBeNull();
    expect(build.rows[0]!.causeCount).toBe(0);
  });
});

// ── confirm segregation ─────────────────────────────────────────────────────

describe('source segregation (confirm = positive-only/weak, no circular target)', () => {
  it('confirm rows are flagged weak and their confirmedCause is dropped', () => {
    const labels = [
      label({
        investigationId: 'inv',
        resolved: 'yes',
        source: 'confirm',
        confirmedCause: 'the report summary itself (circular)',
      }),
    ];
    const build = buildCorpus(labels, resolverFor({ inv: report({ causes: [{ id: 'c1', finalScore: 0.9 }] }) }));
    expect(build.rows[0]!.weak).toBe(true);
    expect(build.rows[0]!.confirmedCause).toBeNull();
    expect(build.bySource).toEqual({ feedback: 0, confirm: 1 });
  });

  it('feedback rows keep their confirmedCause', () => {
    const labels = [label({ investigationId: 'inv', source: 'feedback', confirmedCause: 'real cause' })];
    const build = buildCorpus(labels, resolverFor({ inv: report({ causes: [{ id: 'c1', finalScore: 0.5 }] }) }));
    expect(build.rows[0]!.confirmedCause).toBe('real cause');
  });
});

// ── baseline math parity ────────────────────────────────────────────────────

describe('BaselineReport math == summarizeOutcomeLabels', () => {
  it('strict/weighted/n/bySource mirror summarizeOutcomeLabels exactly', () => {
    const labels = [
      label({ investigationId: 'a', resolved: 'yes', source: 'feedback', project: 'p1' }),
      label({ investigationId: 'b', resolved: 'partly', source: 'confirm', project: 'p1' }),
      label({ investigationId: 'c', resolved: 'no', source: 'feedback', project: 'p2' }),
    ];
    const summary = summarizeOutcomeLabels(labels);
    const baseline = computeBaseline(labels);
    expect(baseline.n).toBe(summary.evaluated);
    expect(baseline.strictHitRate).toBe(summary.accuracy);
    expect(baseline.weightedHitRate).toBe(summary.weightedScore);
    expect(baseline.classBalance).toEqual(summary.counts);
    expect(baseline.bySource).toEqual(summary.bySource);
  });

  it('byProject slices use the same math per project', () => {
    const labels = [
      label({ investigationId: 'a', resolved: 'yes', project: 'p1' }),
      label({ investigationId: 'b', resolved: 'no', project: 'p1' }),
      label({ investigationId: 'c', resolved: 'yes', project: 'p2' }),
    ];
    const baseline = computeBaseline(labels);
    const p1 = baseline.byProject.find((p) => p.project === 'p1')!;
    expect(p1.n).toBe(2);
    expect(p1.strictHitRate).toBe(0.5);
    const p2 = baseline.byProject.find((p) => p.project === 'p2')!;
    expect(p2.strictHitRate).toBe(1);
  });
});

// ── determinism ─────────────────────────────────────────────────────────────

describe('determinism (same inputs → byte-identical corpus)', () => {
  const labels = [
    label({ investigationId: 'inv-z', resolved: 'no', at: new Date('2026-06-03T00:00:00Z') }),
    label({ investigationId: 'inv-a', resolved: 'yes', at: new Date('2026-06-01T00:00:00Z') }),
    label({ investigationId: 'inv-m', resolved: 'partly', at: new Date('2026-06-02T00:00:00Z') }),
  ];
  const reports = resolverFor({
    'inv-z': report({ causes: [{ id: 'c1', finalScore: 0.4, factors: [{ factor: 'b', delta: 0.1 }, { factor: 'a', delta: 0.2 }] }] }),
    'inv-a': report({ causes: [{ id: 'c1', finalScore: 0.8 }] }),
    'inv-m': report({ causes: [{ id: 'c1', finalScore: 0.6 }] }),
  });

  it('the jsonl is byte-identical across runs and input orderings', () => {
    const a = serializeCorpus(buildCorpus(labels, reports));
    const b = serializeCorpus(buildCorpus([...labels].reverse(), reports));
    expect(a.jsonl).toBe(b.jsonl);
    // sorted by investigationId: inv-a, inv-m, inv-z
    const ids = a.jsonl.trim().split('\n').map((line) => JSON.parse(line).investigationId);
    expect(ids).toEqual(['inv-a', 'inv-m', 'inv-z']);
    // trailing newline + filename version tag
    expect(a.jsonl.endsWith('\n')).toBe(true);
    expect(a.filename).toBe('corpus-v1.jsonl');
  });

  it('flattened factors are sorted (byte-stable) regardless of explanation order', () => {
    const a = serializeCorpus(buildCorpus(labels, reports));
    const row = JSON.parse(a.jsonl.trim().split('\n').find((l) => JSON.parse(l).investigationId === 'inv-z')!);
    expect(row.headlineCause.factors.map((f: { factor: string }) => f.factor)).toEqual(['a', 'b']);
  });

  it('holdout split is a deterministic 80/20-ish partition by investigationId', () => {
    const a = serializeCorpus(buildCorpus(labels, reports));
    const { train, holdout, holdoutPct } = a.manifest.holdout;
    expect(holdoutPct).toBe(20);
    expect([...train, ...holdout].sort()).toEqual(['inv-a', 'inv-m', 'inv-z']);
    // stable across runs
    const b = serializeCorpus(buildCorpus([...labels].reverse(), reports));
    expect(b.manifest.holdout).toEqual(a.manifest.holdout);
  });
});

// ── feature separation ──────────────────────────────────────────────────────

describe('feature-separation diagnostic (no model)', () => {
  it('separates a factor that is high on yes and low on no, excludes confirm rows', () => {
    const labels = [
      label({ investigationId: 'y1', resolved: 'yes', source: 'feedback' }),
      label({ investigationId: 'y2', resolved: 'yes', source: 'feedback' }),
      label({ investigationId: 'n1', resolved: 'no', source: 'feedback' }),
      label({ investigationId: 'n2', resolved: 'no', source: 'feedback' }),
      // confirm row must be excluded from the contrast (positive-only / circular)
      label({ investigationId: 'c1', resolved: 'yes', source: 'confirm' }),
    ];
    const reports = resolverFor({
      y1: report({ causes: [{ id: 'h', finalScore: 0.9, factors: [{ factor: 'evidence-quality', delta: 0.5 }] }] }),
      y2: report({ causes: [{ id: 'h', finalScore: 0.9, factors: [{ factor: 'evidence-quality', delta: 0.4 }] }] }),
      n1: report({ causes: [{ id: 'h', finalScore: 0.3, factors: [{ factor: 'evidence-quality', delta: -0.2 }] }] }),
      n2: report({ causes: [{ id: 'h', finalScore: 0.3, factors: [{ factor: 'evidence-quality', delta: -0.1 }] }] }),
      c1: report({ causes: [{ id: 'h', finalScore: 0.9, factors: [{ factor: 'evidence-quality', delta: 9 }] }] }),
    });
    const build = buildCorpus(labels, reports);
    const sep = featureSeparation(build.rows);
    expect(sep.evaluated).toBe(4); // confirm excluded
    const eq = sep.factors.find((f) => f.factor === 'evidence-quality')!;
    expect(eq.nYes).toBe(2);
    expect(eq.nNo).toBe(2);
    expect(eq.meanYes).toBeCloseTo(0.45, 5);
    expect(eq.meanNo).toBeCloseTo(-0.15, 5);
    expect(eq.separation).toBeCloseTo(0.6, 5);
    expect(eq.effectSize).toBeGreaterThan(0);
  });

  it('returns no factors when there is no yes/no contrast', () => {
    const labels = [label({ investigationId: 'y1', resolved: 'yes', source: 'feedback' })];
    const reports = resolverFor({
      y1: report({ causes: [{ id: 'h', finalScore: 0.9, factors: [{ factor: 'x', delta: 0.5 }] }] }),
    });
    const sep = featureSeparation(buildCorpus(labels, reports).rows);
    // one factor discovered but only a yes group → still listed with nNo 0
    expect(sep.evaluated).toBe(1);
    const x = sep.factors.find((f) => f.factor === 'x')!;
    expect(x.nNo).toBe(0);
  });
});
