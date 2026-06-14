/**
 * HOR-18 — Unit tests for memory helpers (pure, no I/O, no DB).
 */

import { describe, it, expect } from 'vitest';
import type { InvestigationReport } from './types.js';
import { moduleArea, tagOverlap, deriveTags, deriveSignature } from './memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal synthetic InvestigationReport for testing. */
function makeReport(overrides?: Partial<InvestigationReport>): InvestigationReport {
  const base: InvestigationReport = {
    id: 'test-id',
    input: { hint: 'test hint' },
    summary: 'Test summary',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    confidence: 0.5,
    nextActions: [],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// moduleArea
// ---------------------------------------------------------------------------

describe('moduleArea', () => {
  it('returns the first 3 path segments for a deep path', () => {
    expect(moduleArea('src/modules/zoho/zoho.service.ts')).toBe('src/modules/zoho');
  });

  it('returns the whole path when there are 3 or fewer segments', () => {
    expect(moduleArea('a.ts')).toBe('a.ts');
    expect(moduleArea('src/foo.ts')).toBe('src/foo.ts');
    expect(moduleArea('a/b/c')).toBe('a/b/c');
  });

  it('handles a path with exactly 4 segments', () => {
    expect(moduleArea('a/b/c/d.ts')).toBe('a/b/c');
  });

  it('returns empty string for empty input', () => {
    expect(moduleArea('')).toBe('');
  });

  it('handles a leading slash by stripping it', () => {
    expect(moduleArea('/src/modules/zoho/zoho.service.ts')).toBe('src/modules/zoho');
  });
});

// ---------------------------------------------------------------------------
// tagOverlap
// ---------------------------------------------------------------------------

describe('tagOverlap', () => {
  it('returns 1/3 for ["a","b"] vs ["b","c"]', () => {
    // intersection={b}, union={a,b,c}, Jaccard = 1/3
    expect(tagOverlap(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('returns 0 for disjoint sets', () => {
    expect(tagOverlap(['a', 'b'], ['c', 'd'])).toBe(0);
  });

  it('returns 1 for identical sets', () => {
    expect(tagOverlap(['x', 'y'], ['x', 'y'])).toBe(1);
  });

  it('returns 0 when both arrays are empty', () => {
    expect(tagOverlap([], [])).toBe(0);
  });

  it('returns 0 when one array is empty', () => {
    expect(tagOverlap(['a'], [])).toBe(0);
    expect(tagOverlap([], ['b'])).toBe(0);
  });

  it('handles duplicates within one side gracefully (set semantics)', () => {
    // Sets deduplicate: {a,b} vs {b,c} -> same as base case
    expect(tagOverlap(['a', 'b', 'a'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });
});

// ---------------------------------------------------------------------------
// deriveTags
// ---------------------------------------------------------------------------

describe('deriveTags', () => {
  it('includes queue names from boundaryCrossings', () => {
    const r = makeReport({
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'orders', producer: 'OrderService', worker: 'OrderProcessor', evidenceId: 'ev1' },
        ],
      },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('orders');
  });

  it('includes top hypothesis category', () => {
    const r = makeReport({
      hypotheses: [
        {
          id: 'hyp1',
          category: 'queue-backlog',
          statement: 'Some statement',
          confidence: 0.8,
          priorConfidence: 0.8,
          verdict: 'supported',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
    });
    const tags = deriveTags(r);
    expect(tags).toContain('queue-backlog');
  });

  it('includes module area from first seed filePath', () => {
    const r = makeReport({
      seeds: [
        {
          id: 'sym1',
          name: 'ZohoService',
          filePath: 'src/modules/zoho/zoho.service.ts',
          startLine: 1,
        },
      ],
    });
    const tags = deriveTags(r);
    expect(tags).toContain('src/modules/zoho');
  });

  it('includes service from input', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'zoho-service' },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('zoho-service');
  });

  it('deduplicates and lowercases tags', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'Orders' },
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'Orders', producer: null, worker: null, evidenceId: 'ev1' },
        ],
      },
    });
    const tags = deriveTags(r);
    const ordersCount = tags.filter((t) => t === 'orders').length;
    expect(ordersCount).toBe(1);
    expect(tags.every((t) => t === t.toLowerCase())).toBe(true);
  });

  it('combines queue, hypothesis category, module area, and service', () => {
    const r = makeReport({
      input: { hint: 'test', service: 'payment-svc' },
      seeds: [
        {
          id: 'sym1',
          name: 'PayService',
          filePath: 'src/modules/payment/pay.service.ts',
          startLine: 10,
        },
      ],
      hypotheses: [
        {
          id: 'hyp1',
          category: 'deployment-regression',
          statement: 'Test',
          confidence: 0.5,
          priorConfidence: 0.5,
          verdict: 'unconfirmed',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'payments', producer: 'PayService', worker: 'PayWorker', evidenceId: 'ev1' },
        ],
      },
    });
    const tags = deriveTags(r);
    expect(tags).toContain('payments');
    expect(tags).toContain('deployment-regression');
    expect(tags).toContain('src/modules/payment');
    expect(tags).toContain('payment-svc');
  });
});

// ---------------------------------------------------------------------------
// deriveSignature
// ---------------------------------------------------------------------------

describe('deriveSignature', () => {
  it('produces the expected pipe-joined string', () => {
    const r = makeReport({
      seeds: [
        {
          id: 'sym1',
          name: 'OrderService',
          filePath: 'src/modules/orders/order.service.ts',
          startLine: 1,
        },
      ],
      hypotheses: [
        {
          id: 'hyp1',
          category: 'queue-backlog',
          statement: 'Test',
          confidence: 0.5,
          priorConfidence: 0.5,
          verdict: 'unconfirmed',
          supportingEvidenceIds: [],
          contradictingEvidenceIds: [],
          supportingPresent: 0,
          contradictingPresent: 0,
          missingEvidence: [],
          rationale: 'test',
        },
      ],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'orders', producer: 'OrderService', worker: 'OrderWorker', evidenceId: 'ev1' },
        ],
      },
    });
    const sig = deriveSignature(r);
    // Format: '<area>|<topHypCategory>|<sortedQueues>'
    expect(sig).toBe('src/modules/orders|queue-backlog|orders');
  });

  it('handles empty seeds and hypotheses', () => {
    const r = makeReport({
      seeds: [],
      hypotheses: [],
      timeline: { events: [], boundaryCrossings: [] },
    });
    const sig = deriveSignature(r);
    expect(sig).toBe('||');
  });

  it('sorts multiple queue names alphabetically', () => {
    const r = makeReport({
      seeds: [],
      hypotheses: [],
      timeline: {
        events: [],
        boundaryCrossings: [
          { queueName: 'zebra', producer: null, worker: null, evidenceId: 'ev1' },
          { queueName: 'alpha', producer: null, worker: null, evidenceId: 'ev2' },
        ],
      },
    });
    const sig = deriveSignature(r);
    // queues should be sorted: 'alpha,zebra'
    expect(sig).toBe('||alpha,zebra');
  });
});
