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

export type RefineMode = 'focus' | 'ignore' | 'none';

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

const TOPIC_MAP: Record<string, TopicEntry> = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function detectMode(d: string): RefineMode {
  if (/\b(ignore|exclude|without|skip|drop)\b/.test(d)) return 'ignore';
  if (/\b(focus|only|just|concentrate|look at)\b/.test(d)) return 'focus';
  return 'none';
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
  const mode = detectMode(d);
  const topics = matchedTopics(d);

  // ── No recognizable topics or mode=none: return everything ────────────────
  if (mode === 'none' || topics.length === 0) {
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
