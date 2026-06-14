/**
 * HOR-31 — Incident simulation + training mode.
 *
 * Provides a fixed catalogue of synthetic scenarios so engineers can practice
 * investigations on pre-canned inputs and compare their reasoning with Horus —
 * without waiting for a real outage. Everything here is deterministic and pure.
 */

import type { InvestigationReport } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExpectedSignal {
  key: string;
  label: string;
}

export interface Scenario {
  id: string;
  title: string;
  category: string;
  symptom: string;
  hint: string;
  since?: string;
  expectedSignals: ExpectedSignal[];
  coachingTips: string[];
}

export interface SignalCheck {
  label: string;
  ok: boolean;
}

export interface ScenarioEvaluation {
  checks: SignalCheck[];
  passed: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Scenario catalogue
// ---------------------------------------------------------------------------

export const SCENARIOS: Scenario[] = [
  {
    id: 'queue-backlog',
    title: 'Queue backlog',
    category: 'queue',
    symptom:
      'Zoho CRM records update minutes late and on-call suspects the worker cannot keep up with the queue.',
    hint: 'zoho realtime sync delays',
    expectedSignals: [
      { key: 'seed', label: 'Seed symbols resolved' },
      { key: 'queue-boundary', label: 'Queue boundary crossing detected' },
      { key: 'hyp:queue-backlog', label: 'queue-backlog hypothesis present' },
      { key: 'hyp:worker-slowdown', label: 'worker-slowdown hypothesis present' },
      { key: 'gaps', label: 'Evidence gaps identified' },
      { key: 'actions', label: 'Next actions generated' },
    ],
    coachingTips: [
      'Check BullMQ depth and failed/delayed counts for the zoho-sync queues.',
      'Compare producer enqueue rate vs worker drain rate to determine if the worker is keeping up.',
    ],
  },
  {
    id: 'external-api-outage',
    title: 'External API outage',
    category: 'integration',
    symptom:
      'Zoho API calls are timing out and returning 5xx and downstream sync is failing.',
    hint: 'zoho api client request',
    expectedSignals: [
      { key: 'seed', label: 'Seed symbols resolved' },
      { key: 'hyp:external-api-latency', label: 'external-api-latency hypothesis present' },
      { key: 'gaps', label: 'Evidence gaps identified' },
      { key: 'actions', label: 'Next actions generated' },
    ],
    coachingTips: [
      'Pull request latency and error-rate metrics for the Zoho client.',
      'Check whether retries are amplifying load on the already-failing Zoho API.',
    ],
  },
  {
    id: 'deployment-regression',
    title: 'Deployment regression',
    category: 'change',
    symptom: 'Errors spiked shortly after the most recent deploy of the sync service.',
    hint: 'zoho sync processing',
    since: 'HEAD~10',
    expectedSignals: [
      { key: 'seed', label: 'Seed symbols resolved' },
      { key: 'hyp:deployment-regression', label: 'deployment-regression hypothesis present' },
      { key: 'actions', label: 'Next actions generated' },
    ],
    coachingTips: [
      'Run horus what-changed zoho to see what shipped in the last deploy.',
      'A change is evidence, not a conclusion — correlate the diff with the error spike timing.',
    ],
  },
  {
    id: 'database-slowdown',
    title: 'Database slowdown',
    category: 'infra',
    symptom: 'Everything touching the database is slow and queries are backing up.',
    hint: 'prisma service',
    expectedSignals: [
      { key: 'seed', label: 'Seed symbols resolved' },
      { key: 'hyp:infrastructure', label: 'infrastructure hypothesis present' },
      { key: 'gaps', label: 'Evidence gaps identified' },
    ],
    coachingTips: [
      'Check DB pool saturation and slow-query logs for Prisma connections.',
      'Infrastructure issues propagate widely — look for correlated slowdowns across multiple services.',
    ],
  },
  {
    id: 'cache-failure',
    title: 'Cache failure',
    category: 'infra',
    symptom:
      'Redis cache misses are hammering the source of truth and latency is climbing.',
    hint: 'redis cache',
    expectedSignals: [
      { key: 'seed', label: 'Seed symbols resolved' },
      { key: 'hyp:infrastructure', label: 'infrastructure hypothesis present' },
      { key: 'gaps', label: 'Evidence gaps identified' },
    ],
    coachingTips: [
      'Check Redis hit/miss ratio and eviction rates.',
      'A cold cache becomes a database slowdown — check whether DB query volume spiked in tandem.',
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a scenario by id. Returns null when not found so callers can branch
 * cleanly without throwing.
 */
export function getScenario(id: string): Scenario | null {
  return SCENARIOS.find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Compare a live InvestigationReport against the expected signals for a
 * scenario. Returns a check per signal (ok / not-ok) plus passed / total
 * counts.
 *
 * Key mapping:
 *   seed             → report.seeds.length > 0
 *   queue-boundary   → report.timeline.boundaryCrossings.length > 0
 *   gaps             → report.gapAnalysis.gaps.length > 0
 *   actions          → report.nextActions.length > 0
 *   hyp:<category>   → report.hypotheses.some(h => h.category === category)
 *   (unknown)        → false
 */
export function evaluateScenario(
  scenario: Scenario,
  report: InvestigationReport,
): ScenarioEvaluation {
  const checks: SignalCheck[] = scenario.expectedSignals.map((signal) => {
    let ok: boolean;

    if (signal.key === 'seed') {
      ok = report.seeds.length > 0;
    } else if (signal.key === 'queue-boundary') {
      ok = report.timeline.boundaryCrossings.length > 0;
    } else if (signal.key === 'gaps') {
      ok = report.gapAnalysis.gaps.length > 0;
    } else if (signal.key === 'actions') {
      ok = report.nextActions.length > 0;
    } else if (signal.key.startsWith('hyp:')) {
      const category = signal.key.slice(4);
      ok = report.hypotheses.some((h) => h.category === category);
    } else {
      ok = false;
    }

    return { label: signal.label, ok };
  });

  let passed = 0;
  for (const check of checks) {
    if (check.ok) passed++;
  }

  return { checks, passed, total: checks.length };
}
