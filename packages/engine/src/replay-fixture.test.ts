/**
 * HOR-71 — Replay fixture integrity tests.
 *
 * Verifies that INCIDENT_001_FIXTURE is internally consistent:
 *   - evidence spans all three signal categories
 *   - CODEOWNERS resolution matches the expected owner constant
 *   - all finding evidenceIds reference IDs that exist in the evidence array
 *   - sourceStatus reflects the fixture's log contribution
 *   - suspectedCause sourceEvidenceIds reference valid evidence IDs
 *
 * All tests are offline — no connectors, no git, no network.
 */

import { describe, it, expect } from 'vitest';
import { resolveOwner, FIXTURE_CODEOWNERS_RULES } from '@horus/core';
import {
  INCIDENT_001_FIXTURE,
  INCIDENT_001_CHANGED_FILE,
  INCIDENT_001_EXPECTED_OWNER,
} from './replay-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function evidenceIds(): Set<string> {
  return new Set(INCIDENT_001_FIXTURE.evidence.map((e) => e.id));
}

// ---------------------------------------------------------------------------
// Evidence signal coverage
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — evidence signal coverage', () => {
  it('has at least one history-source evidence item', () => {
    expect(INCIDENT_001_FIXTURE.evidence.some((e) => e.source === 'history')).toBe(true);
  });

  it('has at least one logs-source evidence item', () => {
    expect(INCIDENT_001_FIXTURE.evidence.some((e) => e.source === 'logs')).toBe(true);
  });

  it('has at least one code-source evidence item', () => {
    expect(INCIDENT_001_FIXTURE.evidence.some((e) => e.source === 'code')).toBe(true);
  });

  it('ev-001-commit has kind "commit" and priority "high"', () => {
    const ev = INCIDENT_001_FIXTURE.evidence.find((e) => e.id === 'ev-001-commit');
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe('commit');
    expect(ev?.priority).toBe('high');
  });

  it('ev-002-log has kind "log" and priority "critical"', () => {
    const ev = INCIDENT_001_FIXTURE.evidence.find((e) => e.id === 'ev-002-log');
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe('log');
    expect(ev?.priority).toBe('critical');
  });

  it('ev-003-symbol has kind "symbol" and links to sym-001', () => {
    const ev = INCIDENT_001_FIXTURE.evidence.find((e) => e.id === 'ev-003-symbol');
    expect(ev).toBeDefined();
    expect(ev?.kind).toBe('symbol');
    expect((ev?.links as Record<string, unknown>)?.['symbolId']).toBe('sym-001');
  });
});

// ---------------------------------------------------------------------------
// CODEOWNERS resolution
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — CODEOWNERS resolution', () => {
  it('INCIDENT_001_CHANGED_FILE resolves to INCIDENT_001_EXPECTED_OWNER via FIXTURE_CODEOWNERS_RULES', () => {
    const result = resolveOwner(INCIDENT_001_CHANGED_FILE, FIXTURE_CODEOWNERS_RULES);
    expect(result.kind).toBe('owned');
    if (result.kind === 'owned') {
      expect(result.owners).toContain(INCIDENT_001_EXPECTED_OWNER);
    }
  });

  it('INCIDENT_001_EXPECTED_OWNER is @horus/connectors-team', () => {
    expect(INCIDENT_001_EXPECTED_OWNER).toBe('@horus/connectors-team');
  });

  it('INCIDENT_001_CHANGED_FILE points to the bullmq worker file', () => {
    expect(INCIDENT_001_CHANGED_FILE).toBe('packages/connectors/src/bullmq/worker.ts');
  });
});

// ---------------------------------------------------------------------------
// Finding — evidence ID integrity
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — finding evidenceIds integrity', () => {
  it('all finding evidenceIds reference existing evidence IDs', () => {
    const ids = evidenceIds();
    for (const finding of INCIDENT_001_FIXTURE.findings) {
      for (const eid of finding.evidenceIds) {
        expect(ids.has(eid), `finding "${finding.title}" references unknown evidenceId "${eid}"`).toBe(true);
      }
    }
  });

  it('correlation finding links commit and log evidence', () => {
    const corr = INCIDENT_001_FIXTURE.findings.find((f) => f.kind === 'correlation');
    expect(corr).toBeDefined();
    expect(corr?.evidenceIds).toContain('ev-001-commit');
    expect(corr?.evidenceIds).toContain('ev-002-log');
  });
});

// ---------------------------------------------------------------------------
// Correlation chain integrity
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — correlation chain integrity', () => {
  it('has a chain linking commit and log evidence', () => {
    const chain = INCIDENT_001_FIXTURE.correlation.chains.find(
      (c) => c.evidenceIds.includes('ev-001-commit') && c.evidenceIds.includes('ev-002-log'),
    );
    expect(chain).toBeDefined();
    expect(chain?.strength).toBeGreaterThan(0.5);
  });

  it('all chain evidenceIds reference existing evidence', () => {
    const ids = evidenceIds();
    for (const chain of INCIDENT_001_FIXTURE.correlation.chains) {
      for (const eid of chain.evidenceIds) {
        expect(ids.has(eid), `chain references unknown evidenceId "${eid}"`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Source status
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — sourceStatus', () => {
  it('sourceStatus is defined', () => {
    expect(INCIDENT_001_FIXTURE.sourceStatus).toBeDefined();
  });

  it('logs source has status "contributed" with evidenceCount 1', () => {
    const logs = INCIDENT_001_FIXTURE.sourceStatus?.sources.find((s) => s.source === 'logs');
    expect(logs).toBeDefined();
    expect(logs?.status).toBe('contributed');
    expect(logs?.evidenceCount).toBe(1);
    expect(logs?.configured).toBe(true);
  });

  it('metrics source has status "not-configured"', () => {
    const metrics = INCIDENT_001_FIXTURE.sourceStatus?.sources.find((s) => s.source === 'metrics');
    expect(metrics?.status).toBe('not-configured');
    expect(metrics?.configured).toBe(false);
  });

  it('state source has status "not-configured"', () => {
    const state = INCIDENT_001_FIXTURE.sourceStatus?.sources.find((s) => s.source === 'state');
    expect(state?.status).toBe('not-configured');
  });

  it('queue source has status "not-configured"', () => {
    const queue = INCIDENT_001_FIXTURE.sourceStatus?.sources.find((s) => s.source === 'queue');
    expect(queue?.status).toBe('not-configured');
  });
});

// ---------------------------------------------------------------------------
// Suspected cause integrity
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — suspectedCause integrity', () => {
  it('has exactly one suspected cause', () => {
    expect(INCIDENT_001_FIXTURE.suspectedCauses).toHaveLength(1);
  });

  it('cause-001 sourceEvidenceIds reference valid evidence IDs', () => {
    const cause = INCIDENT_001_FIXTURE.suspectedCauses[0];
    expect(cause).toBeDefined();
    const ids = evidenceIds();
    for (const eid of cause!.sourceEvidenceIds) {
      expect(ids.has(eid), `cause references unknown evidenceId "${eid}"`).toBe(true);
    }
  });

  it('cause-001 has band "likely" (finalScore 0.81)', () => {
    expect(INCIDENT_001_FIXTURE.suspectedCauses[0]?.band).toBe('likely');
  });

  it('cause-001 finalScore is greater than baseScore (adjustments applied)', () => {
    const cause = INCIDENT_001_FIXTURE.suspectedCauses[0]!;
    expect(cause.finalScore).toBeGreaterThan(cause.baseScore);
  });
});

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

describe('INCIDENT_001_FIXTURE — ownership', () => {
  it('likelyMaintainer is Alice Chen with majority share', () => {
    expect(INCIDENT_001_FIXTURE.ownership?.likelyMaintainer).toBe('Alice Chen');
    expect(INCIDENT_001_FIXTURE.ownership?.maintainerShare).toBeGreaterThan(0.5);
  });

  it('ownership file matches INCIDENT_001_CHANGED_FILE', () => {
    expect(INCIDENT_001_FIXTURE.ownership?.file).toBe(INCIDENT_001_CHANGED_FILE);
  });
});
