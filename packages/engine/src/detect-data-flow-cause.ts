/**
 * HOR-446 — source-only DATA-FLOW cause detector.
 *
 * With NO runtime evidence, investigations used to headline only a generic git-recency
 * "deployment-regression". The dogfood (25 repos, 0% precise-cause rate) showed the real mechanism
 * usually sits in the SEED's own source body — in-place mutation, an unawaited async write, a fixed
 * polling cadence, a hardcoded threshold/retry bound — but it was never a candidate. This pure
 * detector scans `ctx.sourceBody` for a small set of HIGH-SIGNAL, tightly-guarded patterns and
 * returns the single best match as a HEDGED, low-prior cause (never a verdict).
 *
 * Honesty (mirrors HOR-438): text-only (no AST), so every pattern pairs a curated vocabulary with a
 * required corroborating gate and a deny-list, strips comments first, and returns null on any doubt.
 * The engine pushes the result as a low-baseScore CauseInput, kept in the observation/possible band
 * by the single-source ceiling — so a genuine runtime/source cause always outranks it.
 */
import type { SymbolContext } from '@horus/core';

export type DataFlowPattern =
  | 'fixed-cadence'
  | 'exact-match-query'
  | 'in-place-mutation'
  | 'unawaited-async-write'
  | 'hardcoded-bound';

export interface DataFlowFinding {
  pattern: DataFlowPattern;
  /** Short matched fragment (for audit + title). */
  matched: string;
  /** Low prior (0.18–0.22): a candidate in source-only runs, but below any genuine cause. */
  baseScore: number;
  /** Hedged, source-only cause title (includes the seed name). */
  title: string;
}

/** Strip block + line comments so a pattern can't match commented-out or doc code. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** Safe regex-group access under noUncheckedIndexedAccess. */
function grp(m: RegExpExecArray, i: number): string {
  return m[i] ?? '';
}

function hedged(symbolName: string, clause: string): string {
  return `${symbolName} could explain this — it ${clause}. Source-only signal: verify against runtime evidence.`;
}

const CONFIG_SRC = /process\.env|config\.|opts\.|options\.|this\.|props\.|import\.meta/;

// 1. fixed-cadence — the most distinctive, lowest-false-positive family.
function detectFixedCadence(body: string, name: string): DataFlowFinding | null {
  const timer = /\bset(?:Interval|Timeout)\s*\(\s*[^,]+,\s*([0-9_]{3,})\s*\)/.exec(body);
  if (timer) {
    const frag = grp(timer, 0).trim().slice(0, 48);
    return { pattern: 'fixed-cadence', matched: frag, baseScore: 0.2, title: hedged(name, `polls/schedules on a fixed interval (\`${frag}\`), so data freshness is bounded by that cadence rather than the event`) };
  }
  const cron = /(['"`])(?:\*|[0-9,*/-]+)(?:\s+[0-9,*/-]+){4}\1/.exec(body);
  if (cron) {
    const frag = grp(cron, 0);
    return { pattern: 'fixed-cadence', matched: frag.slice(0, 48), baseScore: 0.2, title: hedged(name, `runs on a fixed cron cadence (\`${frag}\`), so an effect activates on the next tick, not at its target time`) };
  }
  const cad = /\b(?:pollInterval|refetchInterval|cadence|intervalMs|tickMs)\b\s*[:=]\s*[0-9_]{2,}/.exec(body);
  if (cad && !CONFIG_SRC.test(grp(cad, 0))) {
    const frag = grp(cad, 0).trim().slice(0, 40);
    return { pattern: 'fixed-cadence', matched: frag, baseScore: 0.2, title: hedged(name, `uses a fixed cadence (\`${frag}\`); the symptom may track that interval`) };
  }
  return null;
}

// 1b. exact-match-query — an equality lookup with no normalization, so a value differing only in
// formatting (case/whitespace/leading zeros) returns no rows (HOR-448; the car-plate-finder case).
function detectExactMatchQuery(body: string, name: string): DataFlowFinding | null {
  const sql = /\bWHERE\b[^;]*?["'`]?\b\w+\b["'`]?\s*=\s*[$?:]\w*/i.exec(body);
  if (sql && !/\b(?:LIKE|ILIKE|LOWER|UPPER|TRIM|SIMILAR|REGEXP)\b/i.test(grp(sql, 0))) {
    const frag = grp(sql, 0).trim().slice(0, 48);
    return { pattern: 'exact-match-query', matched: frag, baseScore: 0.2, title: hedged(name, `matches on an exact-equality query (\`${frag}\`) with no normalization, so a value differing only in formatting (case, whitespace, leading zeros) returns no rows`) };
  }
  // ORM exact-field lookup: `.find({ field: … })` / findOne / findUnique with an OBJECT-literal arg
  // (Array.prototype.find takes a predicate fn, not an object, so this is a store/ORM query).
  const orm = /\.(?:find|findOne|findFirst|findUnique)\s*\(\s*\{\s*\w+\s*:/.exec(body);
  if (orm) {
    const frag = grp(orm, 0).trim().slice(0, 40);
    return { pattern: 'exact-match-query', matched: frag, baseScore: 0.2, title: hedged(name, `looks up by an exact field match (\`${frag}\`) with no normalization, so a value differing only in formatting returns no match`) };
  }
  return null;
}

// 2. in-place-mutation — gated on a reducer/store/mutator context.
function detectInPlaceMutation(body: string, ctx: SymbolContext): DataFlowFinding | null {
  const hay = `${ctx.symbol.name} ${ctx.symbol.filePath ?? ''} ${ctx.symbol.signature ?? ''}`;
  const contextual = /reduc|\bslice\b|store|mutat|\bstate\b/i.test(hay) || ctx.imports.some((i) => /redux|zustand|immer|valtio|mobx/i.test(i));
  if (!contextual) return null;
  // If the body clearly produces a NEW reference (the correct immutable path), don't flag it.
  if (/return\s*\{\s*\.\.\.|=>\s*\(?\s*\{\s*\.\.\.|\.\.\.(?:state|prev|draft)\b/.test(body)) return null;
  const assign = /\b(state|store|draft|cache|acc|accumulator)(?:\.[A-Za-z0-9_]+)+\s*=(?!=)/.exec(body);
  const method = /\b(state|store|draft|cache)(?:\.[A-Za-z0-9_]+)*\.(?:push|splice|sort|reverse|pop|shift|unshift)\s*\(/.exec(body);
  const m = assign ?? method;
  if (!m) return null;
  const obj = grp(m, 1) || 'state';
  const frag = grp(m, 0).trim().slice(0, 40);
  return { pattern: 'in-place-mutation', matched: frag, baseScore: 0.2, title: hedged(ctx.symbol.name, `appears to mutate the shared \`${obj}\` object in place (\`${frag}\`) rather than producing a new reference, so downstream readers may observe stale or partially-updated state`) };
}

// 3. unawaited-async-write — a fire-and-forget write whose result is depended on.
function detectUnawaitedWrite(body: string, ctx: SymbolContext): DataFlowFinding | null {
  const isAsync = /\basync\b/.test(ctx.symbol.signature ?? '') || /\bawait\b/.test(body);
  if (!isAsync || !/\bawait\b/.test(body)) return null; // require the seed awaits elsewhere
  const calleeNames = new Set(ctx.callees.map((c) => c.name));
  for (const line of body.split('\n')) {
    const t = line.trim();
    const call = /^([A-Za-z_$][\w.$]*)\s*\(/.exec(t);
    if (!call) continue;
    if (/^(?:await|return|void|yield|const|let|var|if|for|while|}|else|switch|throw|case)\b/.test(t)) continue;
    if (t.includes('.then(') || t.includes('.catch(') || t.includes('await ')) continue;
    const callee = grp(call, 1);
    const fn = callee.split('.').pop() ?? '';
    if (/^(?:emit|log|console|track|debug|warn|error|info|print|notify|next|push|set[A-Z])/.test(fn)) continue;
    const writeLike = /^(?:save|write|flush|persist|commit|sync|update|insert|upsert|fetch|load|send|post)/i.test(fn) || /Async$/.test(fn);
    if (!writeLike) continue;
    if (!calleeNames.has(callee) && !calleeNames.has(fn)) continue; // must be a real callee
    return { pattern: 'unawaited-async-write', matched: t.slice(0, 60), baseScore: 0.19, title: hedged(ctx.symbol.name, `calls \`${fn}\` without \`await\` while awaiting elsewhere, so a later read may race ahead of that write`) };
  }
  return null;
}

// 4. hardcoded-bound — a threshold/retry/limit gate against a bare literal, or an exact-equality bail-out.
function detectHardcodedBound(body: string, name: string): DataFlowFinding | null {
  const eq = /\b(Object\.is|shallowEqual|isEqual)\s*\(/.exec(body);
  if (eq) {
    return { pattern: 'hardcoded-bound', matched: grp(eq, 0).slice(0, 40), baseScore: 0.18, title: hedged(name, `gates on a reference/shallow equality check (\`${grp(eq, 1)}\`), so an in-place or structurally-equal update can be skipped and a change goes unobserved`) };
  }
  const re = /\b([A-Za-z_$][\w$]*)\s*(?:<=|>=|<|>|===|!==)\s*([0-9]+(?:\.[0-9]+)?)\b/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const id = grp(m, 1);
    const n = Number(grp(m, 2));
    if (n === 0 || n === 1) continue; // boundary/index checks are not thresholds
    if (!/thresh|limit|max|min|retr|attempt|backoff|count|rate|ratio|ttl|timeout|delay|capacity|tolerance|distance|score/i.test(id)) continue;
    if (/\.length\b|\bidx\b|\bindex\b|\bi\b/.test(id)) continue;
    const frag = grp(m, 0).trim().slice(0, 40);
    return { pattern: 'hardcoded-bound', matched: frag, baseScore: 0.2, title: hedged(name, `gates the flow on a fixed bound (\`${frag}\`), so behavior can flip at that constant independent of any deploy`) };
  }
  return null;
}

/**
 * Detect the single most-specific source-only data-flow mechanism in the seed's body, or null.
 * Priority order = ascending false-positive risk: cadence (most distinctive) → gated mutation →
 * unawaited write → hardcoded bound (broadest). Returns at most ONE finding (never clutters ranking).
 */
export function detectDataFlowCause(ctx: SymbolContext): DataFlowFinding | null {
  const raw = ctx.sourceBody ?? ctx.snippet ?? '';
  if (raw.length < 40) return null; // too little source to judge — stay silent rather than guess
  const body = stripComments(raw);
  const nm = ctx.symbol.name;
  return (
    detectFixedCadence(body, nm) ??
    detectExactMatchQuery(body, nm) ??
    detectInPlaceMutation(body, ctx) ??
    detectUnawaitedWrite(body, ctx) ??
    detectHardcodedBound(body, nm)
  );
}

/**
 * HOR-448: the mechanism is often ONE HOP from the seed (a callee, or a sibling ranked seed), so the
 * caller scans several symbols' contexts (top seed first, then the next ranked seeds + the seed's
 * direct callees). Returns the FIRST match in the given priority order, or null. Pure.
 */
export function detectDataFlowCauseAcross(contexts: readonly SymbolContext[]): DataFlowFinding | null {
  for (const c of contexts) {
    const f = detectDataFlowCause(c);
    if (f) return f;
  }
  return null;
}
