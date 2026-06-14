/**
 * HOR-7 — Deterministic timeline reconstruction layer.
 * Input: Evidence[]. Output: ordered TimelineEvents + queue boundary crossings.
 * No LLM, no root-cause ranking — pure structural ordering.
 */

import type { Evidence } from '@horus/core';

export interface TimelineEvent {
  order: number;
  at: string | null;
  kind: string;
  title: string;
  evidenceIds: string[];
  boundaryCrossing: boolean;
}

export interface BoundaryCrossing {
  queueName: string;
  producer: string | null;
  worker: string | null;
  evidenceId: string;
}

export interface Timeline {
  events: TimelineEvent[];
  boundaryCrossings: BoundaryCrossing[];
}

/** Priority for untimed evidence kinds; lower = earlier in the untimed block. */
const UNTIMED_PRIORITY: Record<string, number> = {
  symbol: 0,
  flow: 1,
  'queue-edge': 2,
  impact: 3,
};

/**
 * Parse the queue boundary title format:
 *   Queue "orders": OrderService -> OrderProcessor
 * Returns [producer, worker] or [null, null] when the title does not match.
 */
function parseQueueTitle(title: string): [string | null, string | null] {
  const match = /Queue\s+"[^"]*":\s*(.+?)\s*->\s*(.+)$/.exec(title);
  if (!match) return [null, null];
  const producer = match[1]?.trim() ?? null;
  const worker = match[2]?.trim() ?? null;
  return [producer || null, worker || null];
}

/** Guard Date.parse against NaN. */
function safeParse(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

export function buildTimeline(evidence: Evidence[]): Timeline {
  // Partition
  const timed: Evidence[] = [];
  const untimed: Evidence[] = [];
  for (const e of evidence) {
    if (e.timestamp) {
      timed.push(e);
    } else {
      untimed.push(e);
    }
  }

  // Sort timed ascending by timestamp; stable sort preserves input order for ties.
  timed.sort((a, b) => safeParse(a.timestamp!) - safeParse(b.timestamp!));

  // Sort untimed by kind priority, preserving input order within a kind (stable).
  untimed.sort((a, b) => {
    const pa = UNTIMED_PRIORITY[a.kind] ?? 4;
    const pb = UNTIMED_PRIORITY[b.kind] ?? 4;
    return pa - pb;
  });

  // Concatenate: timed first (real-time anchors), then untimed.
  const ordered = [...timed, ...untimed];

  const events: TimelineEvent[] = ordered.map((e, i) => ({
    order: i + 1,
    at: e.timestamp ?? null,
    kind: e.kind,
    title: e.title,
    evidenceIds: [e.id],
    boundaryCrossing: e.kind === 'queue-edge',
  }));

  // Boundary crossings
  const boundaryCrossings: BoundaryCrossing[] = [];
  for (const e of evidence) {
    if (e.kind !== 'queue-edge') continue;
    const queueName = e.links.queueName ?? '';
    const [producer, worker] = parseQueueTitle(e.title);
    boundaryCrossings.push({
      queueName,
      producer,
      worker,
      evidenceId: e.id,
    });
  }

  return { events, boundaryCrossings };
}
