/**
 * INFO-level duration-by-dimension analysis (HOR-434, lever #2).
 *
 * The error-only log path (analyzeErrors) reads ERROR signatures but is blind to the
 * ground truth for duration anomalies, which lives in INFO completion lines — e.g.
 * `Completed MANAGE_SALES:KSA ~2m10s` / `Completed MANAGE_SALES:UAE ~19ms`. This module
 * turns a window of INFO completion logs into per-dimension duration statistics
 * (region / market / tenant), so the engine can see that one segment is 2m10s while
 * another is 19ms instead of treating the job as a single uniform population.
 *
 * Every function here is PURE (no I/O) and shared by the Elasticsearch AND Axiom
 * providers. The graceful contract: no completion logs, no parseable duration, or no
 * extractable dimension → return `null`. Never throw.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single (dimension value, duration) observation extracted from one log line. */
export interface DurationSample {
  /** The grouping value, e.g. 'KSA' / 'UAE' / 'tenant-7'. */
  dimension: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

/** Aggregate duration statistics for one dimension value. */
export interface DimensionStat {
  /** Mean duration (ms). */
  avg: number;
  /** 95th-percentile duration (ms, nearest-rank). */
  p95: number;
  /** Number of observations. */
  count: number;
  /** Smallest observed duration (ms). */
  min: number;
  /** Largest observed duration (ms). */
  max: number;
}

/**
 * Per-dimension duration breakdown — the shape the engine consumes, e.g.
 * `{ dimension: 'region', unit: 'ms', byValue: { KSA: {...}, UAE: {...} }, sampleCount: 42 }`.
 */
export interface DurationByDimension {
  /** The dimension name, e.g. 'region' / 'market' / 'tenant'. */
  dimension: string;
  unit: 'ms';
  /** Stats keyed by dimension value. */
  byValue: Record<string, DimensionStat>;
  /** Total number of (dimension, duration) samples observed. */
  sampleCount: number;
}

/** How to extract the grouping dimension from a log line. */
export interface DimensionSpec {
  /** Output name, e.g. 'region' / 'market' / 'tenant'. */
  name: string;
  /** A structured field path holding the value (e.g. 'context.market', 'job_id'). */
  field?: string;
  /**
   * Regex (with a capture group) to extract the value from text. Applied to
   * `patternField` (default 'message'). E.g. `:([A-Z]{2,})$` on a job id `NAME:KSA`.
   * `field` takes precedence when both are set.
   */
  pattern?: string;
  /** Field the `pattern` is applied to. Defaults to the message body. */
  patternField?: string;
}

/** How to read the duration out of a log line. */
export interface DurationDimensionOptions {
  /** Dimension extraction config. */
  dimension: DimensionSpec;
  /**
   * Structured numeric/string field holding the duration. Numbers are read as `unit`
   * (default ms); strings are parsed (`"2m10s"`, `"19ms"`). Takes precedence over
   * message parsing.
   */
  durationField?: string;
  /** Unit of a NUMERIC `durationField`. Default 'ms'. */
  durationFieldUnit?: 'ms' | 's';
  /**
   * Regex (with a capture group) to isolate the duration substring inside the message
   * before parsing. When omitted, the whole message is scanned for duration tokens.
   */
  durationPattern?: string;
  /**
   * Only consider lines whose message contains this text (case-insensitive), e.g.
   * `"Completed"`. Used by providers to scope the query AND filter client-side.
   */
  completionText?: string;
  /** Window / scope passthrough for the provider query. */
  from?: string;
  to?: string;
  service?: string;
  /** Minimum log level to query. Default 'info'. */
  level?: string;
  /** Max rows to pull for client-side aggregation. Default 500. */
  limit?: number;
}

/** A normalized log line the pure extractors can read (provider-agnostic). */
export interface DurationLogLike {
  /** The message body, when known. */
  message?: string;
  /** All structured fields (flat or nested), keyed by name. */
  fields: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Field access (local — no ES coupling)
// ---------------------------------------------------------------------------

/** Read a (possibly dotted) path from a record, supporting flat + nested keys. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  const parts = path.split('.');
  let node: unknown = obj;
  for (const part of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

const UNIT_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  'µs': 0.001,
  ns: 0.000_001,
};

// 'ms' MUST precede 'm'/'s' in the alternation so "19ms" reads as milliseconds.
// The trailing negative lookahead (no following letter) allows compound forms like
// "2m10s" (m followed by a digit) while rejecting a unit letter inside a word
// ("5 markets" must NOT read '5m'). A following digit is fine (it's the next part).
const DURATION_TOKEN = /(\d+(?:\.\d+)?)\s*(ms|us|µs|ns|h|m|s)(?![a-zA-Z])/gi;

/**
 * Parse a human duration string into milliseconds. Handles compound forms
 * (`"2m10s"`, `"1h2m3s"`), single units (`"19ms"`, `"1.5s"`, `"500us"`), an optional
 * leading `~`, and a bare number (treated as ms). Returns `null` when nothing parses.
 */
export function parseDurationMs(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^~/, '');
  if (s === '') return null;

  let total = 0;
  let matched = false;
  DURATION_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DURATION_TOKEN.exec(s)) !== null) {
    const value = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const factor = UNIT_MS[unit];
    if (Number.isFinite(value) && factor !== undefined) {
      total += value * factor;
      matched = true;
    }
  }
  if (matched) return total;

  // Bare number → milliseconds.
  if (/^\d+(?:\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First capture group of `regex` applied to `text`, trimmed; null when no match. */
export function extractByRegex(text: string, regex: RegExp): string | null {
  const m = regex.exec(text);
  if (m === null) return null;
  const captured = m[1] ?? m[0];
  const v = captured.trim();
  return v === '' ? null : v;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/** Nearest-rank percentile over an ascending-sorted array. `p` in [0,100]. */
export function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0]!;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(n - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

/** Compute avg/p95/count/min/max over a list of durations (ms). */
export function computeStat(durations: number[]): DimensionStat {
  const finite = durations.filter((d) => Number.isFinite(d));
  if (finite.length === 0) {
    return { avg: 0, p95: 0, count: 0, min: 0, max: 0 };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, d) => acc + d, 0);
  return {
    avg: sum / sorted.length,
    p95: percentile(sorted, 95),
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// ---------------------------------------------------------------------------
// Extraction + aggregation
// ---------------------------------------------------------------------------

function readDimension(rec: DurationLogLike, spec: DimensionSpec): string | null {
  if (spec.field !== undefined) {
    const raw = readPath(rec.fields, spec.field);
    if (raw === null || raw === undefined) {
      // Fall through to a message pattern when configured, else give up.
      if (spec.pattern === undefined) return null;
    } else {
      const v = String(raw).trim();
      if (v !== '') return v;
      if (spec.pattern === undefined) return null;
    }
  }
  if (spec.pattern !== undefined) {
    const sourceField = spec.patternField;
    const text =
      sourceField !== undefined
        ? typeof readPath(rec.fields, sourceField) === 'string'
          ? (readPath(rec.fields, sourceField) as string)
          : String(readPath(rec.fields, sourceField) ?? '')
        : (rec.message ?? '');
    if (text === '') return null;
    try {
      return extractByRegex(text, new RegExp(spec.pattern));
    } catch {
      return null;
    }
  }
  return null;
}

function readDuration(rec: DurationLogLike, opts: DurationDimensionOptions): number | null {
  if (opts.durationField !== undefined) {
    const raw = readPath(rec.fields, opts.durationField);
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return opts.durationFieldUnit === 's' ? raw * 1000 : raw;
    }
    if (typeof raw === 'string') return parseDurationMs(raw);
    return null;
  }
  const msg = rec.message ?? '';
  if (msg === '') return null;
  if (opts.durationPattern !== undefined) {
    let isolated: string | null;
    try {
      isolated = extractByRegex(msg, new RegExp(opts.durationPattern));
    } catch {
      isolated = null;
    }
    return isolated !== null ? parseDurationMs(isolated) : null;
  }
  return parseDurationMs(msg);
}

/**
 * Extract (dimension, durationMs) samples from a window of normalized log lines.
 * Skips lines without a completion match, a parseable duration, or an extractable
 * dimension. Pure — the network/query lives in the providers.
 */
export function extractDurationSamples(
  records: DurationLogLike[],
  opts: DurationDimensionOptions,
): DurationSample[] {
  const needle = opts.completionText?.toLowerCase();
  const out: DurationSample[] = [];
  for (const rec of records) {
    if (needle !== undefined) {
      const hay = (rec.message ?? '').toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    const dimension = readDimension(rec, opts.dimension);
    if (dimension === null) continue;
    const durationMs = readDuration(rec, opts);
    if (durationMs === null || !Number.isFinite(durationMs)) continue;
    out.push({ dimension, durationMs });
  }
  return out;
}

/**
 * Aggregate samples into per-dimension stats. Returns `null` when there are no
 * samples (the graceful "nothing to report" signal). A single dimension value is
 * still returned — the engine decides whether cross-segment variance is meaningful.
 */
export function aggregateDurations(
  samples: DurationSample[],
  dimensionName: string,
): DurationByDimension | null {
  if (samples.length === 0) return null;
  const grouped = new Map<string, number[]>();
  for (const s of samples) {
    const list = grouped.get(s.dimension);
    if (list === undefined) grouped.set(s.dimension, [s.durationMs]);
    else list.push(s.durationMs);
  }
  const byValue: Record<string, DimensionStat> = {};
  for (const [value, durations] of grouped) {
    byValue[value] = computeStat(durations);
  }
  return {
    dimension: dimensionName,
    unit: 'ms',
    byValue,
    sampleCount: samples.length,
  };
}

/**
 * One-shot convenience: extract samples from records and aggregate. Returns `null`
 * when nothing usable is found. Used by both the ES and Axiom providers.
 */
export function durationsByDimension(
  records: DurationLogLike[],
  opts: DurationDimensionOptions,
): DurationByDimension | null {
  const samples = extractDurationSamples(records, opts);
  return aggregateDurations(samples, opts.dimension.name);
}
