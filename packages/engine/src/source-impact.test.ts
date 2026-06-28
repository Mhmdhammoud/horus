/**
 * HOR-385 — source-impact investigation mode.
 *
 * Verifies the structural ("what depends on X" / "is X isolated from Y") path:
 *   1. the seed pins onto the PROMPT-named symbol, not a central node;
 *   2. NO deployment-regression cause and NO deployment-regression hypothesis are emitted;
 *   3. confidence is NOT capped by runtime gaps (ceiling forced to 1.0);
 *   4. the summary LEADS with the impact / isolation verdict.
 *
 * The cross-cutting invariant — an INCIDENT hint's report is byte-identical (every new
 * flag defaults off) — is guarded by the normalized snapshot at the bottom.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';
import type { InvestigationReport } from './types.js';

// ---------------------------------------------------------------------------
// Symbols — a CENTRAL controller (would win on architectural role) and the
// PROMPT-named provider the user actually asked about.
// ---------------------------------------------------------------------------

const CENTRAL: Symbol = {
  id: 'sym:src/app.controller.ts:AppController',
  name: 'AppController',
  filePath: 'src/app.controller.ts',
  startLine: 10,
  endLine: 80,
};

const NAMED: Symbol = {
  id: 'sym:src/slide/slide-editor.provider.ts:SlideEditorProvider',
  name: 'SlideEditorProvider',
  filePath: 'src/slide/slide-editor.provider.ts',
  startLine: 5,
  endLine: 40,
};

const FIELD_STORE: Symbol = {
  id: 'sym:src/field/field-store.ts:FieldStore',
  name: 'FieldStore',
  filePath: 'src/field/field-store.ts',
  startLine: 1,
  endLine: 30,
};

const OTHER_A: Symbol = { id: 'sym:a:A', name: 'A', filePath: 'src/a.ts', startLine: 1, endLine: 5 };
const OTHER_B: Symbol = { id: 'sym:b:B', name: 'B', filePath: 'src/b.ts', startLine: 1, endLine: 5 };

function ctxFor(s: Symbol): SymbolContext {
  return {
    symbol: s,
    callers: [],
    callees: [],
    imports: [],
    usesType: [],
    community: null,
    coupledWith: [],
  };
}

/**
 * Build a fake code provider. `affectedTargets` becomes the depth-2 impact set so the
 * verify-isolation verdict can be exercised both ways.
 */
function makeCode(affectedTargets: Symbol[]): CodeProvider {
  const impact: ImpactResult = {
    target: NAMED,
    affected: 2 + affectedTargets.length,
    byDepth: [
      { depth: 1, symbols: [OTHER_A, OTHER_B] },
      { depth: 2, symbols: affectedTargets },
    ],
  };
  return {
    id: 'fake-code',
    kind: 'code',
    async health() {
      return { ok: true, detail: 'fake' };
    },
    // Return the central controller FIRST so search order + role would normally make it win;
    // the source-impact pin must override that and seed the named provider.
    async searchSymbols(query: string) {
      if (/slideeditorprovider/i.test(query)) return [NAMED, CENTRAL];
      return [CENTRAL, NAMED];
    },
    async context(id: string) {
      return ctxFor(id === NAMED.id ? NAMED : CENTRAL);
    },
    async impact() {
      return impact;
    },
    async flowsFor() {
      return [];
    },
    async detectChanges(): Promise<ChangeSet> {
      return { added: [], removed: [], modified: [] };
    },
    async cypher(): Promise<CypherResult> {
      return { columns: [], rows: [], rowCount: 0 };
    },
  };
}

const fakeDb = {
  select() {
    return {
      from(_t: unknown) {
        return Promise.resolve([]);
      },
    };
  },
  insert(_t: unknown) {
    return {
      values(_r: unknown) {
        return {
          returning(_c: unknown): Promise<{ id: string }[]> {
            return Promise.resolve([{ id: globalThis.crypto.randomUUID() }]);
          },
        };
      },
    };
  },
  update(_t: unknown) {
    return {
      set(_v: unknown) {
        return {
          where(_c: unknown): Promise<void> {
            return Promise.resolve();
          },
        };
      },
    };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// 1. "what depends on X" — pin + impact-led + suppression
// ---------------------------------------------------------------------------

describe('source-impact mode — "what depends on X" (HOR-385)', () => {
  it('pins the seed to the prompt-named symbol, not the central node', async () => {
    const report = await investigate(
      { hint: 'what depends on SlideEditorProvider' },
      { code: makeCode([]), db: fakeDb },
    );
    expect(report.intent).toBe('source-impact');
    expect(report.seeds[0]?.name).toBe('SlideEditorProvider');
  });

  it('leads the summary with the structural impact result', async () => {
    const report = await investigate(
      { hint: 'what depends on SlideEditorProvider' },
      { code: makeCode([]), db: fakeDb },
    );
    expect(report.summary.startsWith('Impact of SlideEditorProvider:')).toBe(true);
    expect(report.summary).toContain('affected symbol(s)');
  });

  it('emits NO deployment-regression cause and NO deployment-regression hypothesis', async () => {
    // --since would force incident; this is the pure structural path. Provide a changed seed
    // file via git is impossible without repoPath, so assert the categories are simply absent.
    const report = await investigate(
      { hint: 'blast radius of SlideEditorProvider' },
      { code: makeCode([]), db: fakeDb },
    );
    expect(report.suspectedCauses.some((c) => c.id === 'cause:deployment-regression')).toBe(false);
    expect(report.hypotheses.some((h) => h.category === 'deployment-regression')).toBe(false);
    // No runtime hypotheses at all in source-impact mode.
    expect(report.hypotheses).toHaveLength(0);
  });

  it('does NOT cap confidence on runtime gaps — ceiling is 1.0', async () => {
    const report = await investigate(
      { hint: 'what depends on SlideEditorProvider' },
      { code: makeCode([]), db: fakeDb },
    );
    expect(report.gapAnalysis.confidenceCeiling).toBe(1);
    // The runtime gaps (logs/metrics/traces/deployment) are suppressed for display.
    const dims = report.gapAnalysis.gaps.map((g) => g.dimension);
    expect(dims).not.toContain('logs');
    expect(dims).not.toContain('metrics');
    expect(dims).not.toContain('traces');
    expect(dims).not.toContain('deployment records');
  });
});

// ---------------------------------------------------------------------------
// 2. verify-isolation verdict
// ---------------------------------------------------------------------------

describe('source-impact mode — verify-isolation verdict (HOR-385)', () => {
  it('reports DOES affect when the target Y is reachable in the impact set', async () => {
    const report = await investigate(
      { hint: 'verify SlideEditorProvider does not affect FieldStore' },
      { code: makeCode([FIELD_STORE]), db: fakeDb },
    );
    expect(report.intent).toBe('source-impact');
    expect(report.seeds[0]?.name).toBe('SlideEditorProvider');
    expect(report.summary).toContain('SlideEditorProvider DOES affect FieldStore');
  });

  it('reports isolated when the target Y is NOT in the impact set', async () => {
    const report = await investigate(
      { hint: 'verify SlideEditorProvider does not affect FieldStore' },
      { code: makeCode([]), db: fakeDb },
    );
    expect(report.summary).toContain('SlideEditorProvider is isolated from FieldStore');
  });
});

// ---------------------------------------------------------------------------
// 3. INCIDENT regression guard — the incident path is byte-identical (defaults off)
// ---------------------------------------------------------------------------

/**
 * Project a report down to the deterministic, UUID-free fields. The report carries random
 * evidence/report ids and a wall-clock collectedAt; everything below is stable for a fixed
 * input + provider, so it is a safe regression snapshot.
 */
function normalize(r: InvestigationReport): unknown {
  return {
    intent: r.intent,
    summary: r.summary,
    confidence: r.confidence,
    causes: r.suspectedCauses.map((c) => ({
      id: c.id,
      category: c.category,
      band: c.band,
    })),
    hypotheses: r.hypotheses.map((h) => ({ category: h.category, verdict: h.verdict })),
    gapDimensions: r.gapAnalysis.gaps.map((g) => g.dimension),
    confidenceCeiling: r.gapAnalysis.confidenceCeiling,
    findingTitles: r.findings.map((f) => f.title),
  };
}

describe('incident path is unchanged by source-impact mode (HOR-385 invariant)', () => {
  // A symptom-bearing incident hint with a diffable --since → the deployment-regression
  // cause + hypothesis MUST still be produced, runtime gaps + ceilings MUST still apply.
  const incidentInput = { hint: 'AppController is throwing 500s', since: 'HEAD~5..HEAD' } as const;
  // detectChanges reports a modified symbol so the commit evidence + regression cause fire.
  const incidentCode: CodeProvider = {
    ...makeCode([]),
    async detectChanges(): Promise<ChangeSet> {
      return {
        added: [],
        removed: [],
        modified: [{ before: CENTRAL, after: CENTRAL }],
      };
    },
  };

  it('classifies incident and keeps the full regression scaffold', async () => {
    const report = await investigate(incidentInput, { code: incidentCode, db: fakeDb });
    expect(report.intent).toBe('incident');
    // Regression cause + hypothesis present (suppression did NOT fire).
    expect(report.suspectedCauses.some((c) => c.id === 'cause:deployment-regression')).toBe(true);
    expect(report.hypotheses.some((h) => h.category === 'deployment-regression')).toBe(true);
    // Runtime honesty intact: gaps exist and the ceiling is below 1.0.
    expect(report.gapAnalysis.gaps.length).toBeGreaterThan(0);
    expect(report.gapAnalysis.confidenceCeiling).toBeLessThan(1);
    // Summary is NOT the structural impact lead.
    expect(report.summary.startsWith('Impact of')).toBe(false);
  });

  it('byte-stable snapshot of the normalized incident report', async () => {
    const report = await investigate(incidentInput, { code: incidentCode, db: fakeDb });
    expect(normalize(report)).toMatchSnapshot();
  });
});
