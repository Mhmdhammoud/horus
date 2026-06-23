/**
 * Unit tests for `horus watch` detection + hint derivation (HOR-CLI).
 *
 * Covers the two things that make a watcher correct:
 *   1. New-incident detection with a seen-set that dedups across polls (an incident
 *      triggers an investigation exactly once).
 *   2. Hint derivation from a Sentry issue and an Elasticsearch error signature.
 *
 * These are the pure decision points; the engine wiring is exercised by the shared
 * investigation-runner + the investigate tests, so we keep these offline and fast.
 */

import { describe, it, expect } from 'vitest';
import type { SentryIssue, ErrorSignature } from '@horus/connectors';
import {
  detectNewSentryIncidents,
  detectNewEsSignatures,
  hintFromSentryIssue,
  hintFromEsSignature,
  headlineFor,
} from './watch.js';
import type { InvestigationReport } from '@horus/engine';

function issue(over: Partial<SentryIssue> & { id: string }): SentryIssue {
  return { title: '(untitled)', count: 0, userCount: 0, ...over };
}

function sig(over: Partial<ErrorSignature> & { key: string }): ErrorSignature {
  return {
    count: 1,
    firstSeen: '2026-06-22T00:00:00Z',
    lastSeen: '2026-06-22T01:00:00Z',
    services: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Sentry: new-incident detection + seen-set dedup across polls
// ---------------------------------------------------------------------------

describe('detectNewSentryIncidents', () => {
  it('returns all issues on the first poll and records them as seen', () => {
    const seen = new Set<string>();
    const a = issue({ id: '1' });
    const b = issue({ id: '2' });
    const fresh = detectNewSentryIncidents([a, b], seen);
    expect(fresh.map((i) => i.id)).toEqual(['1', '2']);
    expect(seen.has('1')).toBe(true);
    expect(seen.has('2')).toBe(true);
  });

  it('does NOT re-trigger an issue seen in a previous poll (dedup by id)', () => {
    const seen = new Set<string>();
    // Poll 1: issues 1 and 2 are new.
    const poll1 = detectNewSentryIncidents([issue({ id: '1' }), issue({ id: '2' })], seen);
    expect(poll1.map((i) => i.id)).toEqual(['1', '2']);

    // Poll 2: 1 and 2 reappear (still open) and 3 is genuinely new — only 3 fires.
    const poll2 = detectNewSentryIncidents(
      [issue({ id: '1' }), issue({ id: '2' }), issue({ id: '3' })],
      seen,
    );
    expect(poll2.map((i) => i.id)).toEqual(['3']);
  });

  it('skips issues with an empty id (un-trackable)', () => {
    const seen = new Set<string>();
    const fresh = detectNewSentryIncidents([issue({ id: '' }), issue({ id: '7' })], seen);
    expect(fresh.map((i) => i.id)).toEqual(['7']);
  });
});

// ---------------------------------------------------------------------------
// Elasticsearch: only NEW signatures, deduped across polls by key
// ---------------------------------------------------------------------------

describe('detectNewEsSignatures', () => {
  it('returns only signatures flagged isNew', () => {
    const seen = new Set<string>();
    const fresh = detectNewEsSignatures(
      [sig({ key: 'E_DB', isNew: true }), sig({ key: 'E_OLD', isNew: false }), sig({ key: 'E_X' })],
      seen,
    );
    expect(fresh.map((s) => s.key)).toEqual(['E_DB']);
  });

  it('does NOT re-trigger a NEW signature already acted on in a prior poll', () => {
    const seen = new Set<string>();
    const poll1 = detectNewEsSignatures([sig({ key: 'E_DB', isNew: true })], seen);
    expect(poll1.map((s) => s.key)).toEqual(['E_DB']);

    // E_DB is still flagged NEW in the next window, but we've already investigated it.
    const poll2 = detectNewEsSignatures(
      [sig({ key: 'E_DB', isNew: true }), sig({ key: 'E_NET', isNew: true })],
      seen,
    );
    expect(poll2.map((s) => s.key)).toEqual(['E_NET']);
  });

  it('skips signatures with an empty key', () => {
    const seen = new Set<string>();
    const fresh = detectNewEsSignatures([sig({ key: '', isNew: true })], seen);
    expect(fresh).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hint derivation
// ---------------------------------------------------------------------------

describe('hintFromSentryIssue', () => {
  it('uses the title and appends the culprit when present', () => {
    const hint = hintFromSentryIssue(
      issue({
        id: '1',
        title: "TypeError: Cannot read properties of undefined (reading 'sku')",
        culprit: 'syncBrandFulfillments(brand.service)',
      }),
    );
    expect(hint).toBe(
      "TypeError: Cannot read properties of undefined (reading 'sku') (syncBrandFulfillments(brand.service))",
    );
  });

  it('falls back to just the title when there is no culprit', () => {
    const hint = hintFromSentryIssue(issue({ id: '1', title: 'Redis connection lost' }));
    expect(hint).toBe('Redis connection lost');
  });

  it('falls back to a shortId event_code when title + culprit are absent', () => {
    const withShortId = {
      ...issue({ id: '1', title: '' }),
      shortId: 'LEADCALL-API-3X',
    } as SentryIssue;
    expect(hintFromSentryIssue(withShortId)).toBe('LEADCALL-API-3X');
  });

  it('bounds the hint to 200 characters', () => {
    const hint = hintFromSentryIssue(issue({ id: '1', title: 'x'.repeat(500) }));
    expect(hint.length).toBe(200);
  });
});

describe('hintFromEsSignature', () => {
  it('uses the signature key (event_code) and appends a sample message', () => {
    const hint = hintFromEsSignature(
      sig({ key: 'E_DB_TIMEOUT', sampleMessage: 'connection to primary timed out' }),
    );
    expect(hint).toBe('E_DB_TIMEOUT: connection to primary timed out');
  });

  it('uses just the key when there is no sample message', () => {
    expect(hintFromEsSignature(sig({ key: 'E_RATE_LIMIT' }))).toBe('E_RATE_LIMIT');
  });

  it('falls back to the sample message when the key is "(none)"', () => {
    const hint = hintFromEsSignature(sig({ key: '(none)', sampleMessage: 'unhandled rejection' }));
    expect(hint).toBe('unhandled rejection');
  });
});

// ---------------------------------------------------------------------------
// Headline extraction for the per-incident output line
// ---------------------------------------------------------------------------

describe('headlineFor', () => {
  it('returns the top suspected cause title and overall confidence', () => {
    const report = {
      id: 'abc',
      confidence: 0.82,
      suspectedCauses: [{ title: 'Redis pool exhausted' }, { title: 'secondary' }],
    } as unknown as InvestigationReport;
    expect(headlineFor(report)).toEqual({ cause: 'Redis pool exhausted', confidence: 0.82 });
  });

  it('degrades gracefully when there are no suspected causes', () => {
    const report = { id: 'abc', confidence: 0.4, suspectedCauses: [] } as unknown as InvestigationReport;
    expect(headlineFor(report)).toEqual({ cause: 'no clear cause', confidence: 0.4 });
  });
});
