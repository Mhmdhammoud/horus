import { describe, it, expect } from 'vitest';
import type { Symbol, SymbolContext } from '@horus/core';
import type { InvestigationGraph } from './graph.js';
import { detectDataFlowCause, detectDataFlowCauseAcross } from './detect-data-flow-cause.js';
import { rankCauses, type CauseInput, type ScoringContext } from './score-cause.js';

function mkCtx(
  sourceBody: string,
  opts: { name?: string; filePath?: string; signature?: string; callees?: string[]; imports?: string[] } = {},
): SymbolContext {
  const symbol: Symbol = {
    id: `sym:${opts.name ?? 'fn'}`,
    name: opts.name ?? 'fn',
    filePath: opts.filePath ?? 'src/x.ts',
    startLine: 1,
    ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
  };
  return {
    symbol,
    sourceBody,
    callers: [],
    callees: (opts.callees ?? []).map((n) => ({ id: `sym:${n}`, name: n, filePath: 'src/y.ts', startLine: 1 })),
    imports: opts.imports ?? [],
    usesType: [],
    community: null,
    coupledWith: [],
  };
}

describe('detectDataFlowCause — fixed-cadence', () => {
  it('fires on setInterval/Timeout with a literal interval', () => {
    const f = detectDataFlowCause(mkCtx('function poll() { setInterval(() => refetch(), 30000); }'));
    expect(f?.pattern).toBe('fixed-cadence');
  });
  it('fires on a cron literal', () => {
    const f = detectDataFlowCause(mkCtx("function boot(){ cron.schedule('0 */5 * * *', runSale); doMore(); }"));
    expect(f?.pattern).toBe('fixed-cadence');
  });
  it('does NOT fire when the interval comes from a variable (not a literal)', () => {
    expect(detectDataFlowCause(mkCtx('function poll(){ setInterval(refetch, delayMs); doStuff(); }'))).toBeNull();
  });
});

describe('detectDataFlowCause — in-place-mutation (gated on reducer/store context)', () => {
  it('fires for an in-place mutation in a reducer', () => {
    const f = detectDataFlowCause(mkCtx('switch(action.type){ case X: state.items.push(action.item); return state; }', { name: 'cartReducer', filePath: 'src/reducers/cart.ts' }));
    expect(f?.pattern).toBe('in-place-mutation');
  });
  it('does NOT fire without a reducer/store context (same mutation in a plain helper)', () => {
    expect(detectDataFlowCause(mkCtx('state.count = compute(); return ok;', { name: 'doThing', filePath: 'src/math.ts', signature: '(a, b)' }))).toBeNull();
  });
  it('does NOT fire when the body uses the correct immutable spread', () => {
    expect(detectDataFlowCause(mkCtx('return { ...state, items: [...state.items, action.item] };', { name: 'cartReducer', filePath: 'src/reducers/cart.ts' }))).toBeNull();
  });
});

describe('detectDataFlowCause — unawaited-async-write', () => {
  it('fires on a fire-and-forget write callee while awaiting elsewhere', () => {
    const body = 'const v = await validate(order);\nsaveOrder(order);\nreturn v;';
    const f = detectDataFlowCause(mkCtx(body, { name: 'process', signature: 'async (order)', callees: ['validate', 'saveOrder'] }));
    expect(f?.pattern).toBe('unawaited-async-write');
  });
  it('does NOT fire when the write is awaited', () => {
    const body = 'const v = await validate(order);\nawait saveOrder(order);\nreturn v;';
    expect(detectDataFlowCause(mkCtx(body, { name: 'process', signature: 'async (order)', callees: ['validate', 'saveOrder'] }))).toBeNull();
  });
  it('does NOT fire for fire-and-forget logging/emit', () => {
    const body = 'const v = await validate(order);\nlogEvent(order);\nreturn v;';
    expect(detectDataFlowCause(mkCtx(body, { name: 'process', signature: 'async (order)', callees: ['validate', 'logEvent'] }))).toBeNull();
  });
});

describe('detectDataFlowCause — hardcoded-bound', () => {
  it('fires on a threshold/retry comparison against a bare literal', () => {
    const f = detectDataFlowCause(mkCtx('function attempt(){ if (retries < 3) { return doRetry(); } return fail(); }'));
    expect(f?.pattern).toBe('hardcoded-bound');
  });
  it('fires on an Object.is / shallow-equality bail-out', () => {
    const f = detectDataFlowCause(mkCtx('function setState(next){ if (Object.is(next, current)) return; notify(next); }'));
    expect(f?.pattern).toBe('hardcoded-bound');
  });
  it('does NOT fire on a loop index / .length / 0 boundary check', () => {
    expect(detectDataFlowCause(mkCtx('for (let i = 0; i < items.length; i++) { handle(items[i]); }'))).toBeNull();
  });
});

describe('detectDataFlowCause — guards', () => {
  it('returns null on a too-short body (nothing to judge)', () => {
    expect(detectDataFlowCause(mkCtx('return 1;'))).toBeNull();
  });
  it('returns at most one finding, cadence taking priority over a bound', () => {
    const f = detectDataFlowCause(mkCtx('function poll(){ if (retries < 3) {} setInterval(refetch, 60000); }'));
    expect(f?.pattern).toBe('fixed-cadence');
  });
});

describe('honesty invariant — a data-flow cause never outranks a genuine cause', () => {
  const emptyCtx: ScoringContext = { evidence: [], graph: { nodes: [], edges: [] } as InvestigationGraph, now: '2026-01-01T00:00:00.000Z' };
  it('a 0.6 genuine cause ranks above the ~0.2 data-flow cause, which stays below the "likely" band', () => {
    const genuine: CauseInput = { id: 'cause:err', title: 'real error', category: 'error-correlation', sourceEvidenceIds: ['e1'], baseScore: 0.6 };
    const dataFlow: CauseInput = { id: 'cause:seed-data-flow', title: 'hedged', category: 'data-flow', sourceEvidenceIds: ['e2'], baseScore: 0.2 };
    const ranked = rankCauses([dataFlow, genuine], emptyCtx);
    expect(ranked[0]?.id).toBe('cause:err');
    const df = ranked.find((c) => c.id === 'cause:seed-data-flow');
    expect(df).toBeDefined();
    expect(df!.finalScore).toBeLessThan(0.65); // never reaches "likely"/"highly-likely"
  });
});

describe('detectDataFlowCause — exact-match-query (HOR-448)', () => {
  it('fires on a SQL WHERE col = $1 with no normalization', () => {
    const f = detectDataFlowCause(mkCtx('async function lookup(p){ return db.query("SELECT * FROM plates WHERE plate_number = $1", [p]); }', { name: 'searchByPlateNumber', signature: 'async (p)' }));
    expect(f?.pattern).toBe('exact-match-query');
  });
  it('does NOT fire when the query normalizes (LOWER/LIKE)', () => {
    expect(detectDataFlowCause(mkCtx('function lookup(p){ return db.query("SELECT * FROM plates WHERE LOWER(plate) = LOWER($1)", [p]); }', { name: 'searchByPlateNumber' }))).toBeNull();
  });
  it('fires on an ORM exact-field find({ field: ... })', () => {
    const f = detectDataFlowCause(mkCtx('async function get(n){ return PlateModel.findOne({ plateNumber: n }); }', { name: 'getPlate', signature: 'async (n)', callees: ['findOne'] }));
    expect(f?.pattern).toBe('exact-match-query');
  });
  it('does NOT fire on Array.prototype.find with a predicate', () => {
    expect(detectDataFlowCause(mkCtx('function pick(items, id){ return items.find((x) => x.id === id); }', { name: 'pick' }))).toBeNull();
  });
});

describe('detectDataFlowCauseAcross (HOR-448) — finds the mechanism one hop from the #1 seed', () => {
  it('returns the mutation in the reducer (seed #2) when the top seed (an action) has no mechanism', () => {
    const actionCtx = mkCtx('export const changeQuantity = (id, qty) => ({ type: "CHANGE", id, qty });', { name: 'changeQuantity', filePath: 'src/actions/cart.ts' });
    const reducerCtx = mkCtx('case "ADD": state.items.push(action.item); return state;', { name: 'cartReducer', filePath: 'src/reducers/cart.ts' });
    const f = detectDataFlowCauseAcross([actionCtx, reducerCtx]);
    expect(f?.pattern).toBe('in-place-mutation');
    expect(f?.title).toContain('cartReducer');
  });
  it('returns null when no scanned context has a detectable mechanism', () => {
    const a = mkCtx('export const noop = () => 1;', { name: 'noop' });
    const b = mkCtx('export const passthrough = (x) => x;', { name: 'passthrough' });
    expect(detectDataFlowCauseAcross([a, b])).toBeNull();
  });
});
