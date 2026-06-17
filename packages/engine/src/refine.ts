/**
 * HOR-21 — Conversational investigation refinement (deterministic v1).
 *
 * Reuses a persisted InvestigationReport's evidence to apply a follow-up
 * directive without re-querying any production connector. Pure and
 * synchronous; no I/O, no randomness, no AI/LLM.
 */

import type { InvestigationReport, CauseCandidate } from './types.js';
import type { ValidatedHypothesis } from './validate.js';
import type { Evidence } from '@horus/core';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RefineMode = 'focus' | 'ignore' | 'mixed' | 'none';

export interface RefinedView {
  directive: string;
  mode: RefineMode;
  topics: string[];
  hypotheses: ValidatedHypothesis[];
  suspectedCauses: CauseCandidate[];
  evidence: Evidence[];
  note: string;
}

// ---------------------------------------------------------------------------
// Topic map
// ---------------------------------------------------------------------------

interface TopicEntry {
  keywords: string[];
  categories: string[];
  kinds: string[];
}

export const TOPIC_MAP: Record<string, TopicEntry> = {
  queue: {
    keywords: ['queue', 'backlog', 'enqueue', 'drain'],
    categories: ['queue-backlog'],
    kinds: ['queue-edge'],
  },
  worker: {
    keywords: ['worker', 'processor', 'slowdown', 'stall', 'consume'],
    categories: ['worker-slowdown'],
    kinds: ['queue-edge'],
  },
  deployment: {
    keywords: ['deploy', 'deployment', 'change', 'commit', 'regression', 'shipped', 'release'],
    categories: ['deployment-regression'],
    kinds: ['commit'],
  },
  api: {
    keywords: ['api', 'external', 'upstream', 'latency'],
    categories: ['external-api-latency'],
    kinds: ['metric'],
  },
  retry: {
    keywords: ['retry', 'storm'],
    categories: ['retry-storm'],
    kinds: ['log'],
  },
  infra: {
    keywords: ['infra', 'infrastructure', 'redis', 'database', 'network'],
    categories: ['infrastructure'],
    kinds: ['redis-key'],
  },
};

const ALL_TOPICS = Object.keys(TOPIC_MAP) as Array<keyof typeof TOPIC_MAP>;

// Stop-words and mode verbs stripped before text-based fallback matching.
const STOP_WORDS = new Set([
  'on', 'the', 'a', 'an', 'at', 'in', 'of', 'and', 'or', 'for', 'with',
  'by', 'to', 'from', 'that', 'this', 'is', 'are', 'was', 'were', 'it',
  'be', 'about', 'focus', 'ignore', 'exclude', 'only', 'just', 'concentrate',
  'look', 'without', 'skip', 'drop',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasFocusVerb(d: string): boolean {
  return /\b(focus|only|just|concentrate|look at)\b/.test(d);
}

function hasIgnoreVerb(d: string): boolean {
  return /\b(ignore|exclude|without|skip|drop)\b/.test(d);
}

function detectMode(d: string): 'focus' | 'ignore' | 'none' {
  if (/\b(ignore|exclude|without|skip|drop)\b/.test(d)) return 'ignore';
  if (/\b(focus|only|just|concentrate|look at)\b/.test(d)) return 'focus';
  return 'none';
}

/** Split a mixed directive into focus/ignore clauses by "and" / "," separators. */
function splitIntoClauses(d: string): Array<{ clause: string; mode: 'focus' | 'ignore' }> {
  const parts = d.split(/\s+and\s+|\s*,\s*/);
  const clauses: Array<{ clause: string; mode: 'focus' | 'ignore' }> = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (hasFocusVerb(trimmed)) clauses.push({ clause: trimmed, mode: 'focus' });
    else if (hasIgnoreVerb(trimmed)) clauses.push({ clause: trimmed, mode: 'ignore' });
  }
  return clauses;
}

/** Apply a directive that contains both focus and ignore verbs — split, apply both. */
function applyMixedDirective(r: InvestigationReport, directive: string, d: string): RefinedView {
  const clauses = splitIntoClauses(d);

  const focusClauses = clauses.filter((c) => c.mode === 'focus');
  const ignoreClauses = clauses.filter((c) => c.mode === 'ignore');

  const focusTopics = [...new Set(focusClauses.flatMap((c) => matchedTopics(c.clause)))];
  const ignoreTopics = [...new Set(ignoreClauses.flatMap((c) => matchedTopics(c.clause)))];

  // Text terms for clauses that didn't match any predefined topic
  const focusTerms = focusClauses
    .filter((c) => matchedTopics(c.clause).length === 0)
    .flatMap((c) => extractSignificantTerms(c.clause));
  const ignoreTerms = ignoreClauses
    .filter((c) => matchedTopics(c.clause).length === 0)
    .flatMap((c) => extractSignificantTerms(c.clause));

  let hypotheses = r.hypotheses as ValidatedHypothesis[];
  let evidence = r.evidence as Evidence[];
  let suspectedCauses = r.suspectedCauses;

  // Apply focus filter (topic-based first, text fallback second)
  if (focusTopics.length > 0) {
    const focusCategories = unionCategories(focusTopics);
    const focusKinds = unionKinds(focusTopics);
    const focusKeywords = topicKeywords(focusTopics);
    hypotheses = hypotheses.filter((h) => focusCategories.includes(h.category));
    evidence = evidence.filter((e) => focusKinds.includes(e.kind) || e.kind === 'symbol');
    const filtered = suspectedCauses.filter((c) =>
      focusKeywords.some((k) => c.title.toLowerCase().includes(k)),
    );
    suspectedCauses = filtered.length > 0 ? filtered : suspectedCauses;
  } else if (focusTerms.length > 0) {
    const matchesFocus = (text: string) => focusTerms.some((t) => text.toLowerCase().includes(t));
    hypotheses = hypotheses.filter((h) => matchesFocus(h.statement) || matchesFocus(h.category));
    evidence = evidence.filter((e) => matchesFocus(e.title) || matchesFocus(e.kind));
    const filtered = suspectedCauses.filter((c) => matchesFocus(c.title));
    suspectedCauses = filtered.length > 0 ? filtered : suspectedCauses;
  }

  // Apply ignore filter on top of whatever the focus filter produced
  if (ignoreTopics.length > 0) {
    const ignoreCategories = unionCategories(ignoreTopics);
    const ignoreKinds = unionKinds(ignoreTopics);
    const ignoreKeywords = topicKeywords(ignoreTopics);
    hypotheses = hypotheses.filter((h) => !ignoreCategories.includes(h.category));
    evidence = evidence.filter((e) => !ignoreKinds.includes(e.kind));
    suspectedCauses = suspectedCauses.filter(
      (c) => !ignoreKeywords.some((k) => c.title.toLowerCase().includes(k)),
    );
  }
  if (ignoreTerms.length > 0) {
    const matchesIgnore = (text: string) => ignoreTerms.some((t) => text.toLowerCase().includes(t));
    hypotheses = hypotheses.filter((h) => !matchesIgnore(h.statement) && !matchesIgnore(h.category));
    evidence = evidence.filter((e) => !matchesIgnore(e.title) && !matchesIgnore(e.kind));
    suspectedCauses = suspectedCauses.filter((c) => !matchesIgnore(c.title));
  }

  const allTopics = [...new Set([...focusTopics, ...ignoreTopics])];

  const focusDesc =
    focusTopics.length > 0
      ? `focus: ${focusTopics.join(', ')}`
      : focusTerms.length > 0
        ? `focus on: ${focusTerms.join(', ')}`
        : null;
  const ignoreDesc =
    ignoreTopics.length > 0
      ? `ignore: ${ignoreTopics.join(', ')}`
      : ignoreTerms.length > 0
        ? `ignore: ${ignoreTerms.join(', ')}`
        : null;
  const modeDesc = [focusDesc, ignoreDesc].filter(Boolean).join('; ');

  const note =
    modeDesc + ". Reused the saved investigation's evidence — no re-query of production.";

  return { directive, mode: 'mixed', topics: allTopics, hypotheses, suspectedCauses, evidence, note };
}

function matchedTopics(d: string): string[] {
  return ALL_TOPICS.filter((t) => {
    const entry = TOPIC_MAP[t];
    if (entry === undefined) return false;
    return entry.keywords.some((k) => d.includes(k));
  });
}

function unionCategories(topics: string[]): string[] {
  const cats: string[] = [];
  for (const t of topics) {
    const entry = TOPIC_MAP[t];
    if (entry === undefined) continue;
    for (const c of entry.categories) {
      if (!cats.includes(c)) cats.push(c);
    }
  }
  return cats;
}

function unionKinds(topics: string[]): string[] {
  const kinds: string[] = [];
  for (const t of topics) {
    const entry = TOPIC_MAP[t];
    if (entry === undefined) continue;
    for (const k of entry.kinds) {
      if (!kinds.includes(k)) kinds.push(k);
    }
  }
  return kinds;
}

function topicKeywords(topics: string[]): string[] {
  const kws: string[] = [];
  for (const t of topics) {
    const entry = TOPIC_MAP[t];
    if (entry === undefined) continue;
    for (const k of entry.keywords) {
      if (!kws.includes(k)) kws.push(k);
    }
  }
  return kws;
}

/** Extract significant words from a free-text directive for text-based fallback filtering. */
function extractSignificantTerms(directive: string): string[] {
  return directive
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Filter evidence/hypotheses by text match when no predefined topic matched. */
function applyTextFilter(
  r: InvestigationReport,
  directive: string,
  mode: 'focus' | 'ignore',
  terms: string[],
): RefinedView {
  const matches = (text: string): boolean => terms.some((t) => text.toLowerCase().includes(t));

  const note =
    (mode === 'focus' ? 'Focused on' : 'Excluding') +
    ' terms: ' +
    terms.join(', ') +
    '. No predefined topic matched; filtered by text search. ' +
    "Reused the saved investigation's evidence — no re-query of production.";

  if (mode === 'focus') {
    const hypotheses = r.hypotheses.filter(
      (h) => matches(h.statement) || matches(h.category),
    );
    const evidence = r.evidence.filter((e) => matches(e.title) || matches(e.kind));
    const suspectedCauses = r.suspectedCauses.filter((c) => matches(c.title));
    return {
      directive,
      mode: 'focus',
      topics: [],
      hypotheses,
      evidence,
      suspectedCauses: suspectedCauses.length > 0 ? suspectedCauses : r.suspectedCauses,
      note,
    };
  }

  // ignore mode
  return {
    directive,
    mode: 'ignore',
    topics: [],
    hypotheses: r.hypotheses.filter(
      (h) => !matches(h.statement) && !matches(h.category),
    ),
    evidence: r.evidence.filter((e) => !matches(e.title) && !matches(e.kind)),
    suspectedCauses: r.suspectedCauses.filter((c) => !matches(c.title)),
    note,
  };
}

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

/**
 * Apply a follow-up directive to a persisted investigation report and return
 * a filtered view. Never re-queries Axon or any connector — only the data
 * already in `r` is used.
 */
export function refineInvestigation(
  r: InvestigationReport,
  directive: string,
): RefinedView {
  const d = directive.toLowerCase();

  // When the directive contains BOTH a focus verb and an ignore verb, split it
  // into clauses and apply focus and ignore independently so neither overrides
  // the other. Without this, detectMode() picks ignore first (regex order) and
  // maps "focus on X and ignore Y" as a pure ignore directive.
  if (hasFocusVerb(d) && hasIgnoreVerb(d)) {
    return applyMixedDirective(r, directive, d);
  }

  const mode = detectMode(d);
  const topics = matchedTopics(d);

  // ── No recognizable topics or mode=none ────────────────────────────────────
  if (mode === 'none' || topics.length === 0) {
    // When mode is focus/ignore but no predefined topic keyword matched, try a
    // text-based fallback using significant words from the directive.
    if (mode !== 'none' && topics.length === 0) {
      const terms = extractSignificantTerms(d);
      if (terms.length > 0) {
        return applyTextFilter(r, directive, mode, terms);
      }
    }

    const recognizedList = ALL_TOPICS.join(', ');
    const note =
      'No specific topic directive recognized. ' +
      'Recognized topics: ' +
      recognizedList +
      '. ' +
      'Example usage: "focus on queue behavior", "ignore deployment changes".';
    return {
      directive,
      mode: 'none',
      topics,
      hypotheses: r.hypotheses,
      suspectedCauses: r.suspectedCauses,
      evidence: r.evidence,
      note,
    };
  }

  const matchedCategories = unionCategories(topics);
  const matchedKinds = unionKinds(topics);
  const keywords = topicKeywords(topics);

  // ── Focus mode ────────────────────────────────────────────────────────────
  if (mode === 'focus') {
    const hypotheses = r.hypotheses.filter((h) => matchedCategories.includes(h.category));

    const evidence = r.evidence.filter(
      (e) => matchedKinds.includes(e.kind) || e.kind === 'symbol',
    );

    let suspectedCauses = r.suspectedCauses.filter((c) =>
      keywords.some((k) => c.title.toLowerCase().includes(k)),
    );
    if (suspectedCauses.length === 0) {
      suspectedCauses = r.suspectedCauses;
    }

    const note =
      'Focused on ' +
      topics.join(', ') +
      '. Reused the saved investigation\'s evidence — no re-query of production.';

    return { directive, mode: 'focus', topics, hypotheses, suspectedCauses, evidence, note };
  }

  // ── Ignore mode ───────────────────────────────────────────────────────────
  const hypotheses = r.hypotheses.filter((h) => !matchedCategories.includes(h.category));

  const evidence = r.evidence.filter((e) => !matchedKinds.includes(e.kind));

  const suspectedCauses = r.suspectedCauses.filter(
    (c) => !keywords.some((k) => c.title.toLowerCase().includes(k)),
  );

  const note =
    'Excluding ' +
    topics.join(', ') +
    '. Reused the saved investigation\'s evidence — no re-query of production.';

  return { directive, mode: 'ignore', topics, hypotheses, suspectedCauses, evidence, note };
}
