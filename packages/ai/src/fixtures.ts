/**
 * HOR-60 — Reusable narrative fixtures for AI validator tests.
 *
 * Import these in provider adapter tests (HOR-61) and any test that needs
 * a pre-built NarrativeInput / NarrativeOutput without constructing one inline.
 * All fixtures are offline and deterministic — no network calls.
 */

import type { NarrativeInput, NarrativeOutput } from './contract.js';

// ---------------------------------------------------------------------------
// Shared input packet — referenced by all output fixtures below
// ---------------------------------------------------------------------------

/** Base investigation input used by all output fixtures in this file. */
export const FIXTURE_INPUT: NarrativeInput = {
  investigationId: 'inv-fixture-001',
  hint: 'job queue backed up after deploy',
  reportConfidence: 0.72,
  evidence: [
    {
      id: 'ev-log-001',
      kind: 'log',
      title: 'BullMQ worker stalled: job exceeded lockDuration',
      service: 'leadcall-api',
      excerpt: 'Job id=42 stalled after 30000ms',
    },
    {
      id: 'ev-metric-001',
      kind: 'metric',
      title: 'Queue depth spiked to 1 200 jobs',
      service: 'leadcall-api',
    },
    {
      id: 'ev-commit-001',
      kind: 'commit',
      title: 'Increase worker concurrency from 2 to 10',
    },
  ],
  knownServices: ['leadcall-api', 'zoho-sync'],
  suspectedCauses: [
    {
      label: 'Redis connection pool exhausted under high concurrency',
      score: 0.81,
      evidenceIds: ['ev-log-001', 'ev-commit-001'],
    },
  ],
  deterministicSummary:
    'BullMQ workers stalled in leadcall-api after a concurrency increase caused Redis pool exhaustion.',
  findings: [
    { title: 'Concurrency bump correlates with stall onset', evidenceIds: ['ev-commit-001'] },
    { title: 'Queue depth spike follows stall events', evidenceIds: ['ev-metric-001'] },
  ],
};

// ---------------------------------------------------------------------------
// Fixture 1: Valid narrative output
// ---------------------------------------------------------------------------

/**
 * A fully valid NarrativeOutput for FIXTURE_INPUT.
 * All citation IDs exist in the input, confidence is below the ceiling,
 * and all required sections are populated.
 * validateNarrative(FIXTURE_VALID_OUTPUT, FIXTURE_INPUT) must return { valid: true }.
 */
export const FIXTURE_VALID_OUTPUT: NarrativeOutput = {
  what: 'BullMQ job workers began stalling across the leadcall-api service shortly after a concurrency increase was deployed.',
  why: 'Raising worker concurrency from 2 to 10 saturated the Redis connection pool. Each stalled worker held an open connection and never released it, causing subsequent workers to time out waiting for a free slot.',
  whereNext: [
    'Roll back worker concurrency to 2 and confirm stall rate drops',
    'Increase Redis max connection pool size before re-raising concurrency',
    'Add a BullMQ stall-rate alert so the next concurrency change is caught early',
  ],
  citations: [
    { evidenceId: 'ev-log-001', rationale: 'Direct evidence of stall event' },
    { evidenceId: 'ev-commit-001', rationale: 'Config change that triggered the issue' },
    { evidenceId: 'ev-metric-001', rationale: 'Confirms downstream queue depth impact' },
  ],
  confidence: 0.68,
  mentionedServices: ['leadcall-api'],
};

// ---------------------------------------------------------------------------
// Fixture 2: Unknown-evidence citation (hallucinated citation)
// ---------------------------------------------------------------------------

/**
 * A NarrativeOutput that cites an evidence ID not present in FIXTURE_INPUT.
 * validateNarrative(FIXTURE_UNKNOWN_CITATION, FIXTURE_INPUT) must return
 * { valid: false } with an error containing 'hallucinated citation'.
 */
export const FIXTURE_UNKNOWN_CITATION: NarrativeOutput = {
  what: 'Workers stalled after the deploy.',
  why: 'Redis pool was exhausted.',
  whereNext: ['Roll back the concurrency change'],
  citations: [
    { evidenceId: 'ev-log-001' },
    { evidenceId: 'ev-DOES-NOT-EXIST', rationale: 'Invented evidence ID' },
  ],
  confidence: 0.60,
};

// ---------------------------------------------------------------------------
// Fixture 3: Confidence inflation
// ---------------------------------------------------------------------------

/**
 * A NarrativeOutput whose confidence exceeds the FIXTURE_INPUT ceiling (0.72).
 * validateNarrative(FIXTURE_CONFIDENCE_INFLATION, FIXTURE_INPUT) must return
 * { valid: false } with an error containing 'confidence'.
 */
export const FIXTURE_CONFIDENCE_INFLATION: NarrativeOutput = {
  what: 'Workers stalled after the deploy.',
  why: 'Redis pool was exhausted by the concurrency increase.',
  whereNext: ['Reduce worker concurrency'],
  citations: [{ evidenceId: 'ev-commit-001' }],
  confidence: 0.95,
};

// ---------------------------------------------------------------------------
// Fixture 4: Hallucinated service
// ---------------------------------------------------------------------------

/**
 * A NarrativeOutput that declares a service not present in FIXTURE_INPUT.knownServices.
 * validateNarrative(FIXTURE_HALLUCINATED_SERVICE, FIXTURE_INPUT) must return
 * { valid: false } with an error containing 'hallucination'.
 */
export const FIXTURE_HALLUCINATED_SERVICE: NarrativeOutput = {
  what: 'Workers stalled after the deploy.',
  why: 'Redis pool was exhausted.',
  whereNext: ['Reduce worker concurrency'],
  citations: [{ evidenceId: 'ev-log-001' }],
  confidence: 0.60,
  mentionedServices: ['leadcall-api', 'invented-service-xyz'],
};
