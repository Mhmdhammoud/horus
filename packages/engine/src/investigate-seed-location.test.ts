/**
 * HOR-206 — Regression test: investigation seed evidence uses real line ranges.
 *
 * Guards against the regression where investigation/replay/postmortem emitted
 * `symbol (src/file.ts:0)` because searchSymbols returned symbols without line
 * ranges and the engine formatted them as `:0`.
 *
 * The fix (HOR-211/214) added `hydrateLines` to the source-intelligence provider and
 * `formatSymbolLocation` to the engine. This test confirms the full investigate()
 * pipeline carries startLine/endLine through to seed evidence and findings.
 */

import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext, ImpactResult, ChangeSet, CypherResult } from '@horus/core';
import type { CodeProvider } from '@horus/connectors';
import type { HorusDb } from '@horus/db';
import { investigate } from './engine.js';

// ---------------------------------------------------------------------------
// Fake providers
// ---------------------------------------------------------------------------

const SEED_SYMBOL: Symbol = {
  id: 'sym:resolvers:getSaleWithLink',
  name: 'getSaleWithLink',
  filePath: 'src/resolvers/sales.resolver.ts',
  startLine: 115,
  endLine: 121,
};

const fakeCtx: SymbolContext = {
  symbol: SEED_SYMBOL,
  callers: [],
  callees: [],
  imports: [],
  usesType: [],
  community: null,
  coupledWith: [],
};

const fakeCode: CodeProvider = {
  id: 'fake-code',
  kind: 'code',
  async health() { return { ok: true, detail: 'fake' }; },
  async searchSymbols() { return [SEED_SYMBOL]; },
  async context() { return fakeCtx; },
  async impact(): Promise<ImpactResult> { return { target: SEED_SYMBOL, affected: 0, byDepth: [] }; },
  async flowsFor() { return []; },
  async detectChanges(): Promise<ChangeSet> { return { added: [], removed: [], modified: [] }; },
  async cypher(): Promise<CypherResult> { return { columns: [], rows: [], rowCount: 0 }; },
};

const fakeDb = {
  select() { return { from(_t: unknown) { return Promise.resolve([]); } }; },
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
    return { set(_v: unknown) { return { where(_c: unknown): Promise<void> { return Promise.resolve(); } }; } };
  },
} as unknown as HorusDb;

// ---------------------------------------------------------------------------
// HOR-206 regression: real line ranges in seed evidence and findings
// ---------------------------------------------------------------------------

describe('investigate() — seed evidence uses real line ranges (HOR-206)', () => {
  it('seed evidence title contains the real start-end range, not :0', async () => {
    const report = await investigate(
      { hint: 'getSaleWithLink' },
      { code: fakeCode, db: fakeDb },
    );

    const seedEv = report.evidence.find((e) => e.kind === 'symbol');
    expect(seedEv).toBeDefined();
    // Must contain the real range, never `:0`
    expect(seedEv?.title).toContain('src/resolvers/sales.resolver.ts:115-121');
    expect(seedEv?.title).not.toContain(':0');
  });

  it('seed finding title contains the real start-end range, not :0', async () => {
    const report = await investigate(
      { hint: 'getSaleWithLink' },
      { code: fakeCode, db: fakeDb },
    );

    const seedFinding = report.findings.find((f) => f.title.startsWith('Seed resolves to'));
    expect(seedFinding).toBeDefined();
    expect(seedFinding?.title).toContain('src/resolvers/sales.resolver.ts:115-121');
    expect(seedFinding?.title).not.toContain(':0');
  });

  it('degrades gracefully when symbol has no line range — bare path, no :0', async () => {
    const noLineSymbol: Symbol = {
      id: 'sym:resolvers:someOther',
      name: 'someOther',
      filePath: 'src/resolvers/other.resolver.ts',
      // startLine and endLine deliberately absent
    };
    const codeWithoutLines: CodeProvider = {
      ...fakeCode,
      async searchSymbols() { return [noLineSymbol]; },
      async context() { return { ...fakeCtx, symbol: noLineSymbol }; },
      async impact() { return { target: noLineSymbol, affected: 0, byDepth: [] }; },
    };

    const report = await investigate(
      { hint: 'someOther' },
      { code: codeWithoutLines, db: fakeDb },
    );

    const seedEv = report.evidence.find((e) => e.kind === 'symbol');
    expect(seedEv).toBeDefined();
    // No line range → bare file path only, never `:0`
    expect(seedEv?.title).toContain('src/resolvers/other.resolver.ts');
    expect(seedEv?.title).not.toContain(':0');
    expect(seedEv?.title).not.toMatch(/:\d/); // no colon-number at all
  });
});

// ---------------------------------------------------------------------------
// HOR-340: a trivial blast radius must not become a tautological top cause
// ("sits on a high-fan-out path (1 affected)"). Require genuine fan-out (>=3).
// ---------------------------------------------------------------------------

describe('investigate() — blast-radius cause requires genuine fan-out (HOR-340)', () => {
  const codeWithAffected = (affected: number): CodeProvider => ({
    ...fakeCode,
    async impact(): Promise<ImpactResult> {
      return { target: SEED_SYMBOL, affected, byDepth: [] };
    },
  });

  it('offers NO blast-radius cause when fan-out is trivial (1 affected)', async () => {
    const report = await investigate(
      { hint: 'getSaleWithLink' },
      { code: codeWithAffected(1), db: fakeDb },
    );
    expect(report.suspectedCauses.some((c) => /fan-out|code reach/i.test(c.title))).toBe(false);
  });

  it('offers a wide-reach cause when fan-out is genuine (>=3 affected)', async () => {
    const report = await investigate(
      { hint: 'getSaleWithLink' },
      { code: codeWithAffected(8), db: fakeDb },
    );
    expect(report.suspectedCauses.some((c) => /code reach/i.test(c.title))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HOR-335: a fuzzy/zero-support seed must be DISCLOSED and damped, not presented
// as a confident result (investigate used to silently seed garbage at 0.75).
// ---------------------------------------------------------------------------

describe('investigate() — fuzzy seed disclosed + confidence damped (HOR-335)', () => {
  it('discloses + caps confidence when no meaningful hint token matches the seed', async () => {
    // none of these tokens appear in getSaleWithLink / sales.resolver.ts
    const report = await investigate(
      { hint: 'WidgetFactory exploded catastrophically' },
      { code: fakeCode, db: fakeDb },
    );
    expect(report.summary).toContain('low-confidence closest match');
    expect(report.confidence).toBeLessThanOrEqual(0.45);
  });

  it('does NOT flag when a hint token matches the seed name', async () => {
    const report = await investigate(
      { hint: 'getSaleWithLink is failing' }, // "sale"/"link" match the seed
      { code: fakeCode, db: fakeDb },
    );
    expect(report.summary).not.toContain('low-confidence closest match');
  });
});

// ---------------------------------------------------------------------------
// HOR-336: headline confidence reflects DIAGNOSIS strength — a well-localized run
// with no meaningful root cause is "localized, cause unknown", not a confident
// diagnosis, so it cannot read high.
// ---------------------------------------------------------------------------

describe('investigate() — confidence reflects diagnosis strength (HOR-336)', () => {
  it('caps the headline when no meaningful cause emerges', async () => {
    // seed matches the hint (not fuzzy), but fakeCode has impact.affected=0 and no
    // runtime evidence => no meaningful suspected cause.
    const report = await investigate(
      { hint: 'getSaleWithLink' },
      { code: fakeCode, db: fakeDb },
    );
    expect(report.suspectedCauses[0]?.finalScore ?? 0).toBeLessThan(0.2);
    expect(report.confidence).toBeLessThanOrEqual(0.6);
    // A sub-threshold cause must not headline as "Top suspected cause".
    expect(report.summary).toContain('No dominant suspected cause');
  });
});
