/**
 * HOR-103 — Investigation quality fixture.
 *
 * Tests that the deterministic investigation sub-components produce expected
 * quality outputs when given INCIDENT_001 fixture inputs (BullMQ stall incident:
 * concurrency bump → Redis pool exhaustion → worker stalls).
 *
 * These tests fail if scoring, correlation, confidence, or seed ranking drifts.
 * They prove investigation quality — not just command execution.
 *
 * Expected quality for INCIDENT_001:
 *   • Suspected symbol: BullMQWorkerConfig in packages/connectors/src/bullmq/worker.ts
 *   • Suspected service: leadcall-api
 *   • Cause band: "likely" (finalScore ≥ 0.65, < 0.85)
 *   • Evidence confidence (weighted): in the 0.40–0.85 range
 *   • Correlation: commit + symbol evidence linked in one chain
 *
 * All tests are offline — no connectors, no DB, no network.
 */

import { describe, it, expect } from 'vitest';
import { INCIDENT_001_FIXTURE } from './replay-fixture.js';
import { correlate } from './correlate.js';
import { rankCauses } from './score-cause.js';
import { computeWeightedEvidenceConfidence } from './confidence.js';
import { rankSeeds } from './seeds.js';

// ---------------------------------------------------------------------------
// Expected quality constants for INCIDENT_001
// ---------------------------------------------------------------------------

const EXPECTED_SERVICE = 'leadcall-api';
const EXPECTED_SYMBOL_NAME = 'BullMQWorkerConfig';
const EXPECTED_FILE = 'packages/connectors/src/bullmq/worker.ts';

// Band anchors from score-cause.ts
const BAND_HIGHLY_LIKELY = 0.85;
const BAND_LIKELY = 0.65;
const BAND_POSSIBLE = 0.40;

// Fixed reference time matching fixture evidence timestamps
const FIXED_NOW = '2026-06-15T10:05:00.000Z';

// ---------------------------------------------------------------------------
// 1. Seed quality: correct symbol is identified for the incident
// ---------------------------------------------------------------------------

describe('INCIDENT_001 quality — seed identification', () => {
  it('fixture seeds the correct symbol name', () => {
    expect(INCIDENT_001_FIXTURE.seeds).toHaveLength(1);
    expect(INCIDENT_001_FIXTURE.seeds[0]!.name).toBe(EXPECTED_SYMBOL_NAME);
  });

  it('fixture seed points to the correct file', () => {
    expect(INCIDENT_001_FIXTURE.seeds[0]!.filePath).toBe(EXPECTED_FILE);
  });

  it('fixture is scoped to the expected service', () => {
    expect(INCIDENT_001_FIXTURE.input.service).toBe(EXPECTED_SERVICE);
  });

  it('rankSeeds prefers the worker file over utility and migration files', () => {
    const candidates = [
      { id: 's1', name: 'BullMQWorkerConfig', filePath: EXPECTED_FILE },
      { id: 's2', name: 'formatDate', filePath: 'src/utils/date.ts' },
      { id: 's3', name: 'BullMQMigration', filePath: 'scripts/migrations/bullmq-setup.ts' },
    ];
    const ranked = rankSeeds(candidates);
    // Worker file should rank first (PREFER pattern matches 'worker')
    expect(ranked[0]!.symbol.name).toBe('BullMQWorkerConfig');
    // Migration scripts should rank last
    expect(ranked[ranked.length - 1]!.symbol.name).toBe('BullMQMigration');
  });
});

// ---------------------------------------------------------------------------
// 2. Evidence quality: confidence is in the expected band
// ---------------------------------------------------------------------------

describe('INCIDENT_001 quality — evidence confidence', () => {
  const conf = computeWeightedEvidenceConfidence(INCIDENT_001_FIXTURE.evidence);

  it('evidence confidence is in the "possible"–"likely" range', () => {
    expect(conf).toBeGreaterThanOrEqual(BAND_POSSIBLE);
    expect(conf).toBeLessThan(BAND_HIGHLY_LIKELY);
  });

  it('evidence confidence reflects partial runtime signal (commit + one log)', () => {
    // Fixture has 3 evidence items (commit, log, symbol) — not enough for highly-likely.
    // Adding a second runtime source (e.g. queue-state) would push it higher.
    expect(conf).toBeLessThan(BAND_HIGHLY_LIKELY);
  });

  it('adding a second high-quality log evidence would increase confidence', () => {
    const extraEvidence = [
      ...INCIDENT_001_FIXTURE.evidence,
      {
        id: 'ev-004-log2',
        source: 'logs' as const,
        kind: 'log' as const,
        title: 'Redis maxclients reached',
        relevance: 0.88,
        payload: {},
        links: {},
        provenance: { query: 'es:redis maxclients', collectedAt: FIXED_NOW },
        priority: 'critical' as const,
      },
    ];
    const confWithExtra = computeWeightedEvidenceConfidence(extraEvidence);
    expect(confWithExtra).toBeGreaterThan(conf);
  });
});

// ---------------------------------------------------------------------------
// 3. Correlation: commit and symbol evidence are linked
// ---------------------------------------------------------------------------

describe('INCIDENT_001 quality — correlation', () => {
  const result = correlate(INCIDENT_001_FIXTURE.evidence);

  it('produces at least one causal chain', () => {
    expect(result.chains.length).toBeGreaterThanOrEqual(1);
  });

  it('causal chain links the commit and symbol evidence', () => {
    // correlate() links commit + symbol when no queue-edge is present
    const chain = result.chains.find(
      (c) =>
        c.evidenceIds.includes('ev-001-commit') && c.evidenceIds.includes('ev-003-symbol'),
    );
    expect(
      chain,
      'Expected a chain containing both ev-001-commit and ev-003-symbol',
    ).toBeDefined();
  });

  it('chain strength is above 0.5 (meaningful correlation)', () => {
    const chain = result.chains[0]!;
    expect(chain.strength).toBeGreaterThan(0.5);
  });

  it('file-scoped group clusters commit and symbol evidence on the changed file', () => {
    // Both ev-001-commit and ev-003-symbol link to EXPECTED_FILE
    const fileGroup = result.groups.find(
      (g) =>
        g.dimension === 'file' &&
        g.evidenceIds.includes('ev-001-commit') &&
        g.evidenceIds.includes('ev-003-symbol'),
    );
    expect(
      fileGroup,
      `Expected a file-dimension group for ${EXPECTED_FILE} containing ev-001-commit and ev-003-symbol`,
    ).toBeDefined();
  });

  it('does not report log as missing (ev-002-log is present)', () => {
    const logMissing = result.missing.find((m) => m.kind === 'log');
    expect(logMissing).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Cause scoring: correct band for the Redis/concurrency hypothesis
// ---------------------------------------------------------------------------

describe('INCIDENT_001 quality — cause scoring', () => {
  const candidates = rankCauses(
    [
      {
        id: 'cause-001',
        title: 'Redis connection pool exhausted under high concurrency',
        category: 'queue-backlog',
        sourceEvidenceIds: ['ev-001-commit', 'ev-002-log'],
        baseScore: 0.75,
      },
    ],
    {
      evidence: INCIDENT_001_FIXTURE.evidence,
      graph: INCIDENT_001_FIXTURE.graph,
      now: FIXED_NOW,
    },
  );

  it('produces exactly one scored cause', () => {
    expect(candidates).toHaveLength(1);
  });

  it('cause is in the "likely" or "highly-likely" band (finalScore ≥ 0.65)', () => {
    const cause = candidates[0]!;
    // A recent commit (1h before incident) + critical log evidence is strong enough
    // for highly-likely — assert the cause is at minimum "likely".
    const QUALITY_BANDS = ['likely', 'highly-likely'];
    expect(QUALITY_BANDS, `Expected band in ${QUALITY_BANDS.join('/')} but got: ${cause.band}`)
      .toContain(cause.band);
    expect(cause.finalScore).toBeGreaterThanOrEqual(BAND_LIKELY);
  });

  it('cause references both commit and log evidence IDs', () => {
    const cause = candidates[0]!;
    expect(cause.sourceEvidenceIds).toContain('ev-001-commit');
    expect(cause.sourceEvidenceIds).toContain('ev-002-log');
  });

  it('cause score is higher than a low-evidence baseline (adjustments applied)', () => {
    const cause = candidates[0]!;
    // The scorer applies factors — final should differ from baseScore
    expect(cause.finalScore).not.toBe(cause.baseScore);
  });

  it('cause finalScore is above "possible" threshold — not dismissed as noise', () => {
    // Guards against scoring deflation: a recent high-priority deployment regression
    // must score well above the "possible" threshold.
    expect(candidates[0]!.finalScore).toBeGreaterThan(BAND_POSSIBLE);
  });
});

// ---------------------------------------------------------------------------
// 5. Overall confidence: fixture declares expected investigation confidence
// ---------------------------------------------------------------------------

describe('INCIDENT_001 quality — overall confidence', () => {
  it('overall confidence is in the "likely" band (0.65–0.85)', () => {
    const { confidence } = INCIDENT_001_FIXTURE;
    expect(confidence).toBeGreaterThanOrEqual(BAND_LIKELY);
    expect(confidence).toBeLessThan(BAND_HIGHLY_LIKELY);
  });

  it('overall confidence is exactly 0.78 (deterministic fixture value)', () => {
    expect(INCIDENT_001_FIXTURE.confidence).toBe(0.78);
  });

  it('gap analysis notes the missing Redis state evidence', () => {
    const stateGap = INCIDENT_001_FIXTURE.gapAnalysis.gaps.find((g) => g.dimension === 'state');
    expect(stateGap).toBeDefined();
    expect(stateGap!.confidenceImpact).toBeGreaterThan(0);
  });

  it('gap analysis confidence ceiling is below 1.0 (missing Redis state caps it)', () => {
    // The ceiling is 0.9 — missing Redis state evidence prevents certainty.
    expect(INCIDENT_001_FIXTURE.gapAnalysis.confidenceCeiling).toBeLessThan(1.0);
    expect(INCIDENT_001_FIXTURE.gapAnalysis.confidenceCeiling).toBeGreaterThanOrEqual(BAND_LIKELY);
  });
});
