/**
 * HOR-7 — Pure unit tests for buildTimeline.
 * No I/O, no external deps. Vitest only.
 */

import { describe, expect, it } from 'vitest';
import type { Evidence } from '@horus/core';
import { buildTimeline } from './timeline.js';

function makeEvidence(overrides: Partial<Evidence> & Pick<Evidence, 'id' | 'kind' | 'title'>): Evidence {
  return {
    source: 'code',
    relevance: 0.5,
    payload: null,
    links: {},
    provenance: { query: 'test', collectedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

describe('buildTimeline', () => {
  const timedLater = makeEvidence({
    id: 'ev-timed-later',
    kind: 'commit',
    title: 'Commit B (later)',
    timestamp: '2024-03-02T12:00:00.000Z',
  });

  const timedEarlier = makeEvidence({
    id: 'ev-timed-earlier',
    kind: 'commit',
    title: 'Commit A (earlier)',
    timestamp: '2024-01-15T08:00:00.000Z',
  });

  const untimedSymbol = makeEvidence({
    id: 'ev-symbol',
    kind: 'symbol',
    title: 'Seed symbol MyService',
  });

  const untimedQueueEdge = makeEvidence({
    id: 'ev-queue-edge',
    kind: 'queue-edge',
    title: 'Queue "orders": OrderService -> OrderProcessor',
    links: { queueName: 'orders' },
    source: 'queue',
  });

  // Intentionally pass timed events out of chronological order (later first).
  const input: Evidence[] = [timedLater, timedEarlier, untimedSymbol, untimedQueueEdge];

  it('returns 4 events for 4 evidence items', () => {
    const { events } = buildTimeline(input);
    expect(events).toHaveLength(4);
  });

  it('places timed events first, in ascending timestamp order', () => {
    const { events } = buildTimeline(input);
    // First event = earlier timestamp
    expect(events[0]?.evidenceIds).toContain('ev-timed-earlier');
    // Second event = later timestamp
    expect(events[1]?.evidenceIds).toContain('ev-timed-later');
  });

  it('assigns ascending order values starting at 1', () => {
    const { events } = buildTimeline(input);
    expect(events[0]?.order).toBe(1);
    expect(events[1]?.order).toBe(2);
    expect(events[2]?.order).toBe(3);
    expect(events[3]?.order).toBe(4);
  });

  it('marks the queue-edge event as a boundary crossing', () => {
    const { events } = buildTimeline(input);
    const queueEvent = events.find((e) => e.evidenceIds.includes('ev-queue-edge'));
    expect(queueEvent?.boundaryCrossing).toBe(true);
  });

  it('does not mark non-queue-edge events as boundary crossings', () => {
    const { events } = buildTimeline(input);
    const symbolEvent = events.find((e) => e.evidenceIds.includes('ev-symbol'));
    expect(symbolEvent?.boundaryCrossing).toBe(false);
  });

  it('untimed symbol (priority 0) comes before queue-edge (priority 2)', () => {
    const { events } = buildTimeline(input);
    const symbolIdx = events.findIndex((e) => e.evidenceIds.includes('ev-symbol'));
    const queueIdx = events.findIndex((e) => e.evidenceIds.includes('ev-queue-edge'));
    expect(symbolIdx).toBeLessThan(queueIdx);
  });

  it('produces exactly 1 boundary crossing', () => {
    const { boundaryCrossings } = buildTimeline(input);
    expect(boundaryCrossings).toHaveLength(1);
  });

  it('correctly parses the queue boundary crossing fields', () => {
    const { boundaryCrossings } = buildTimeline(input);
    const bc = boundaryCrossings[0];
    expect(bc?.queueName).toBe('orders');
    expect(bc?.producer).toBe('OrderService');
    expect(bc?.worker).toBe('OrderProcessor');
    expect(bc?.evidenceId).toBe('ev-queue-edge');
  });

  it('timed events have non-null at; untimed events have at === null', () => {
    const { events } = buildTimeline(input);
    const timedEvents = events.filter((e) =>
      e.evidenceIds.includes('ev-timed-earlier') ||
      e.evidenceIds.includes('ev-timed-later'),
    );
    const untimedEvents = events.filter((e) =>
      e.evidenceIds.includes('ev-symbol') ||
      e.evidenceIds.includes('ev-queue-edge'),
    );
    expect(timedEvents.every((e) => e.at !== null)).toBe(true);
    expect(untimedEvents.every((e) => e.at === null)).toBe(true);
  });

  it('handles an empty evidence array', () => {
    const { events, boundaryCrossings } = buildTimeline([]);
    expect(events).toHaveLength(0);
    expect(boundaryCrossings).toHaveLength(0);
  });

  it('handles a queue-edge with an unparseable title gracefully', () => {
    const badEdge = makeEvidence({
      id: 'ev-bad-edge',
      kind: 'queue-edge',
      title: 'No arrow here at all',
      links: { queueName: 'mystery' },
      source: 'queue',
    });
    const { boundaryCrossings } = buildTimeline([badEdge]);
    expect(boundaryCrossings).toHaveLength(1);
    const bc = boundaryCrossings[0];
    expect(bc?.queueName).toBe('mystery');
    expect(bc?.producer).toBeNull();
    expect(bc?.worker).toBeNull();
  });
});
