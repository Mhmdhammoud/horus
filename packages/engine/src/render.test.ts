/**
 * HOR-13 — Unit tests for queue-aware rendering in renderReport() and reportToMarkdown().
 * Pure, no I/O. All evidence is synthesised inline.
 */

import { describe, it, expect } from 'vitest';
import type { Evidence } from '@horus/core';
import type { InvestigationReport, CauseCandidate } from './types.js';
import { renderReport, reportToMarkdown, groupQueueEvidence } from './render.js';

function makeCause(title: string, finalScore: number, sourceEvidenceIds: string[]): CauseCandidate {
  const band = finalScore >= 0.85 ? 'highly-likely' as const
    : finalScore >= 0.65 ? 'likely' as const
    : finalScore >= 0.40 ? 'possible' as const
    : 'observation' as const;
  return {
    id: `cause:${title.slice(0, 24).replace(/\s+/g, '-')}`,
    title,
    category: 'other',
    sourceEvidenceIds,
    affectedNodeIds: [],
    baseScore: finalScore,
    finalScore,
    confidence: finalScore,
    band,
    explanations: [],
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeQueueEv(
  id: string,
  queueName: string,
  title: string,
  relevance: number,
  payload: Record<string, unknown>,
): Evidence {
  return {
    id,
    source: 'queue',
    kind: 'queue-state',
    title,
    relevance,
    payload,
    links: { queueName },
    provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
  };
}

// Summary evidence — has isPaused in payload
const summaryEv = makeQueueEv(
  'ev_qs_0',
  'zoho-sync',
  'zoho-sync: 4382 waiting, 1 active, 12 failed, 0 delayed',
  0.4,
  { queueName: 'zoho-sync', waiting: 4382, active: 1, failed: 12, delayed: 0, completed: 500, isPaused: false },
);

// Backlog anomaly
const backlogEv = makeQueueEv(
  'ev_qs_1',
  'zoho-sync',
  'zoho-sync: 4,382 jobs waiting (severe backlog)',
  0.88,
  { queueName: 'zoho-sync', waiting: 4382, active: 1 },
);

// Worker starvation
const starvationEv = makeQueueEv(
  'ev_qs_2',
  'token-refresh',
  'token-refresh: 423 waiting jobs, 0 active workers — possible starvation',
  0.7,
  { queueName: 'token-refresh', waiting: 423, active: 0 },
);

const starvationSummaryEv = makeQueueEv(
  'ev_qs_3',
  'token-refresh',
  'token-refresh: 423 waiting, 0 active, 0 failed, 0 delayed',
  0.4,
  { queueName: 'token-refresh', waiting: 423, active: 0, failed: 0, delayed: 0, completed: 200, isPaused: false },
);

// Failed breakdown
const failedBreakdownEv = makeQueueEv(
  'ev_qs_4',
  'crm-webhook',
  'crm-webhook: 83% of failed jobs are "TokenRefreshFailed: 401 Unauthorized"',
  0.82,
  {
    queueName: 'crm-webhook',
    topReason: 'TokenRefreshFailed: 401 Unauthorized',
    topCount: 16,
    topPct: 83,
    totalFailed: 120,
    breakdown: [{ reason: 'TokenRefreshFailed: 401 Unauthorized', count: 16 }],
  },
);

const failedSummaryEv = makeQueueEv(
  'ev_qs_5',
  'crm-webhook',
  'crm-webhook: 0 waiting, 1 active, 120 failed, 5 delayed',
  0.4,
  { queueName: 'crm-webhook', waiting: 0, active: 1, failed: 120, delayed: 5, completed: 800, isPaused: false },
);

function makeReport(overrides: Partial<InvestigationReport> = {}): InvestigationReport {
  return {
    id: 'inv-test',
    input: { hint: 'Zoho sync delays' },
    summary: 'Test summary.',
    seeds: [],
    evidence: [],
    timeline: { events: [], boundaryCrossings: [] },
    correlation: { groups: [], chains: [], missing: [] },
    findings: [],
    suspectedCauses: [],
    hypotheses: [],
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph: { nodes: [], edges: [] },
    confidence: 0.6,
    nextActions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupQueueEvidence
// ---------------------------------------------------------------------------

describe('groupQueueEvidence', () => {
  it('groups by queue name and sorts summary last', () => {
    const evs = [summaryEv, backlogEv, starvationEv, starvationSummaryEv];
    const groups = groupQueueEvidence(evs);
    expect([...groups.keys()]).toEqual(['zoho-sync', 'token-refresh']);

    const zoho = groups.get('zoho-sync')!;
    expect(zoho[0]!.id).toBe('ev_qs_1'); // backlog first
    expect(zoho[zoho.length - 1]!.id).toBe('ev_qs_0'); // summary last

    const token = groups.get('token-refresh')!;
    expect(token[0]!.id).toBe('ev_qs_2'); // starvation first
    expect(token[token.length - 1]!.id).toBe('ev_qs_3'); // summary last
  });

  it('ignores non-queue-state evidence', () => {
    const codeEv: Evidence = {
      id: 'ev-code-1',
      source: 'code',
      kind: 'symbol',
      title: 'SomeService',
      relevance: 0.9,
      payload: {},
      links: {},
      provenance: { query: 'test', collectedAt: '2026-06-14T12:00:00Z' },
    };
    const groups = groupQueueEvidence([codeEv, backlogEv]);
    expect(groups.size).toBe(1);
    expect(groups.has('zoho-sync')).toBe(true);
  });

  it('returns empty map when no queue evidence', () => {
    expect(groupQueueEvidence([])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// renderReport — Queue runtime section
// ---------------------------------------------------------------------------

describe('renderReport — queue runtime section', () => {
  it('omits the section entirely when no queue evidence and no gap', () => {
    const r = makeReport();
    const output = renderReport(r);
    expect(output).not.toContain('## Queue runtime');
  });

  it('shows gap.why when queue gap exists but no evidence', () => {
    const r = makeReport({
      gapAnalysis: {
        gaps: [{ dimension: 'queue runtime state', why: 'No Redis connector configured for this environment.', nextSource: 'horus queues', confidenceImpact: 0.1 }],
        blindSpots: [],
        confidenceCeiling: 0.9,
      },
    });
    const output = renderReport(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('No Redis connector configured for this environment.');
  });

  it('renders backlog signal with queue name as sub-header', () => {
    const r = makeReport({ evidence: [summaryEv, backlogEv] });
    const output = renderReport(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('zoho-sync');
    expect(output).toContain('4,382 jobs waiting (severe backlog)');
    expect(output).toContain('[0.88]');
  });

  it('renders summary counts inline for summary evidence', () => {
    const r = makeReport({ evidence: [summaryEv] });
    const output = renderReport(r);
    expect(output).toContain('4382 waiting');
    expect(output).toContain('active');
    expect(output).toContain('failed');
    expect(output).toContain('[0.40]');
  });

  it('renders starvation signal and summary for token-refresh', () => {
    const r = makeReport({ evidence: [starvationEv, starvationSummaryEv] });
    const output = renderReport(r);
    expect(output).toContain('token-refresh');
    expect(output).toContain('possible starvation');
    expect(output).toContain('[0.70]');
  });

  it('renders failed breakdown', () => {
    const r = makeReport({ evidence: [failedBreakdownEv, failedSummaryEv] });
    const output = renderReport(r);
    expect(output).toContain('crm-webhook');
    expect(output).toContain('83%');
    expect(output).toContain('TokenRefreshFailed');
    expect(output).toContain('[0.82]');
  });

  it('renders multiple queues each under their own name', () => {
    const r = makeReport({ evidence: [backlogEv, summaryEv, starvationEv, starvationSummaryEv] });
    const output = renderReport(r);
    const zohoIdx = output.indexOf('zoho-sync');
    const tokenIdx = output.indexOf('token-refresh');
    expect(zohoIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// renderReport — suspected causes tagging
// ---------------------------------------------------------------------------

describe('renderReport — queue-backed suspected causes', () => {
  it('adds [↑ queue] to causes with queue evidence ids', () => {
    const r = makeReport({
      evidence: [backlogEv, summaryEv],
      suspectedCauses: [
        makeCause('Queue zoho-sync is backed up', 0.7, ['ev_qs_1']),
        makeCause('Recent deploy broke auth', 0.4, ['ev-code-1']),
      ],
    });
    const output = renderReport(r);
    expect(output).toContain('[↑ queue]');
    const lines = output.split('\n');
    const queueCause = lines.find((l) => l.includes('zoho-sync is backed up'));
    const nonQueueCause = lines.find((l) => l.includes('Recent deploy broke auth'));
    expect(queueCause).toContain('[↑ queue]');
    expect(nonQueueCause).not.toContain('[↑ queue]');
  });

  it('does not add queue tag when cause has no queue evidence', () => {
    const r = makeReport({
      evidence: [backlogEv],
      suspectedCauses: [
        makeCause('Code path X is broken', 0.5, ['ev-other']),
      ],
    });
    const output = renderReport(r);
    expect(output).not.toContain('[↑ queue]');
  });
});

// ---------------------------------------------------------------------------
// reportToMarkdown — Queue runtime section
// ---------------------------------------------------------------------------

describe('reportToMarkdown — queue runtime section', () => {
  it('omits queue section when no evidence and no gap', () => {
    const r = makeReport();
    const output = reportToMarkdown(r);
    expect(output).not.toContain('## Queue runtime');
  });

  it('renders gap.why in markdown when no queue evidence', () => {
    const r = makeReport({
      gapAnalysis: {
        gaps: [{ dimension: 'queue runtime state', why: 'No Redis connector configured.', nextSource: 'horus queues', confidenceImpact: 0.1 }],
        blindSpots: [],
        confidenceCeiling: 0.9,
      },
    });
    const output = reportToMarkdown(r);
    expect(output).toContain('## Queue runtime');
    expect(output).toContain('No Redis connector configured.');
  });

  it('renders queue signals as bullet list with relevance code', () => {
    const r = makeReport({ evidence: [backlogEv, summaryEv] });
    const output = reportToMarkdown(r);
    expect(output).toContain('**zoho-sync**');
    expect(output).toContain('`0.88`');
    expect(output).toContain('4,382 jobs waiting (severe backlog)');
  });

  it('renders summary counts in markdown', () => {
    const r = makeReport({ evidence: [summaryEv] });
    const output = reportToMarkdown(r);
    expect(output).toContain('`0.40`');
    expect(output).toContain('4382 waiting');
  });

  it('tags queue-backed suspected causes with [↑ queue]', () => {
    const r = makeReport({
      evidence: [backlogEv],
      suspectedCauses: [
        makeCause('Queue backed up', 0.7, ['ev_qs_1']),
        makeCause('Other cause', 0.3, []),
      ],
    });
    const output = reportToMarkdown(r);
    const lines = output.split('\n');
    const queueLine = lines.find((l) => l.includes('Queue backed up'));
    const otherLine = lines.find((l) => l.includes('Other cause'));
    expect(queueLine).toContain('[↑ queue]');
    expect(otherLine).not.toContain('[↑ queue]');
  });
});
