/**
 * HOR-196 — Deterministic cause-chain construction.
 *
 * Builds ordered causal chains from validated hypotheses and the EvidenceGraph.
 * Each chain has 2–4 steps (trigger → propagation → symptom [→ impact]) that
 * cite specific evidence IDs and optionally reference graph node IDs.
 *
 * Pure and synchronous: same inputs → same outputs. No I/O, no randomness.
 */

import type { Evidence } from '@horus/core';
import type { InvestigationGraph } from './graph.js';
import type { ValidatedHypothesis } from './validate.js';

// ── Public types ───────────────────────────────────────────────────────────────

export type CauseChainStepRole = 'trigger' | 'propagation' | 'symptom' | 'impact';

export interface CauseChainStep {
  role: CauseChainStepRole;
  label: string;
  evidenceIds: string[];
  /** Optional ID of a node in the InvestigationGraph that this step represents. */
  graphNodeId?: string;
}

export interface CauseChain {
  /** The hypothesis this chain was derived from. */
  hypothesisId: string;
  category: string;
  /** Adjusted confidence from the validated hypothesis. */
  confidence: number;
  /** Ordered causal steps from trigger to symptom/impact. */
  steps: CauseChainStep[];
  /** One-line causal narrative summarising the full chain. */
  summary: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type EvidenceByKind = Map<string, Evidence[]>;

function groupByKind(ids: string[], evById: Map<string, Evidence>): EvidenceByKind {
  const map: EvidenceByKind = new Map();
  for (const id of ids) {
    const ev = evById.get(id);
    if (!ev) continue;
    const list = map.get(ev.kind) ?? [];
    list.push(ev);
    map.set(ev.kind, list);
  }
  return map;
}

function ids(evs: Evidence[]): string[] {
  return evs.map((e) => e.id);
}

function firstImplicatedNode(
  graph: InvestigationGraph,
  type: string,
): string | undefined {
  return graph.nodes.find((n) => n.type === type && n.implicated)?.id;
}

// ── Chain builders per hypothesis category ─────────────────────────────────────

function chainForDeploymentRegression(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
  seedLabel: string,
): CauseChain {
  const commitEvs = byKind.get('commit') ?? [];
  const symbolEvs = byKind.get('symbol') ?? [];
  const logEvs = byKind.get('log') ?? [];
  const metricEvs = byKind.get('metric') ?? [];
  const impactEvs = byKind.get('impact') ?? [];

  const runtimeEvIds = [...ids(logEvs), ...ids(metricEvs)];
  const steps: CauseChainStep[] = [];

  steps.push({
    role: 'trigger',
    label: commitEvs.length > 0
      ? `Recent change: ${commitEvs[0]?.title ?? 'commit'}`
      : 'Recent change (commit range not captured)',
    evidenceIds: ids(commitEvs),
    graphNodeId: graph.nodes.find((n) => n.type === 'deployment')?.id,
  });

  steps.push({
    role: 'propagation',
    label: `Affected code path: ${seedLabel}` +
      (impactEvs.length > 0
        ? ` (${(impactEvs[0]?.payload as { affected?: number } | undefined)?.affected ?? '?'} downstream symbol(s))`
        : ''),
    evidenceIds: [...ids(symbolEvs), ...ids(impactEvs)],
    graphNodeId: graph.nodes.find((n) => n.type === 'symbol')?.id,
  });

  if (runtimeEvIds.length > 0) {
    steps.push({
      role: 'symptom',
      label: logEvs.length > 0
        ? `Runtime error signatures observed (${logEvs.length} signature(s))`
        : `Metric anomalies observed (${metricEvs.length} signal(s))`,
      evidenceIds: runtimeEvIds,
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  const nonEmpty = steps.filter((s) => s.evidenceIds.length > 0 || s.role === 'trigger');
  const summary =
    `Change to ${seedLabel} → affected code path` +
    (runtimeEvIds.length > 0 ? ' → runtime symptoms observed' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps: nonEmpty, summary };
}

function chainForQueueBacklog(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
  queueName?: string,
): CauseChain {
  const queueEdgeEvs = byKind.get('queue-edge') ?? [];
  const queueStateEvs = byKind.get('queue-state') ?? [];
  const logEvs = byKind.get('log') ?? [];
  const metricEvs = byKind.get('metric') ?? [];

  const queueNodeId = queueName
    ? graph.nodes.find((n) => n.id === `queue:${queueName}`)?.id
    : firstImplicatedNode(graph, 'queue');

  const steps: CauseChainStep[] = [];

  steps.push({
    role: 'trigger',
    label: queueName
      ? `Producer enqueuing to "${queueName}" faster than consumer drains`
      : 'Producer enqueuing faster than consumer drains',
    evidenceIds: ids(queueEdgeEvs),
    graphNodeId: queueNodeId,
  });

  if (queueStateEvs.length > 0) {
    steps.push({
      role: 'propagation',
      label: `Queue depth growing${queueName ? ` on "${queueName}"` : ''}`,
      evidenceIds: ids(queueStateEvs),
      graphNodeId: queueNodeId,
    });
  }

  const symptomEvIds = [...ids(logEvs), ...ids(metricEvs)];
  if (symptomEvIds.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Worker throughput degraded — downstream delays observable',
      evidenceIds: symptomEvIds,
      graphNodeId: firstImplicatedNode(graph, 'worker') ?? firstImplicatedNode(graph, 'service'),
    });
  }

  const summary =
    (queueName ? `"${queueName}" queue` : 'Queue') +
    ' backed up — producers outpacing consumers' +
    (symptomEvIds.length > 0 ? ' → downstream delays' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps, summary };
}

function chainForWorkerSlowdown(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
  queueName?: string,
): CauseChain {
  const queueStateEvs = byKind.get('queue-state') ?? [];
  const metricEvs = byKind.get('metric') ?? [];
  const logEvs = byKind.get('log') ?? [];

  const workerNodeId = firstImplicatedNode(graph, 'worker');
  const queueNodeId = queueName
    ? graph.nodes.find((n) => n.id === `queue:${queueName}`)?.id
    : firstImplicatedNode(graph, 'queue');

  const steps: CauseChainStep[] = [];

  const triggerEvIds = [...ids(queueStateEvs.filter((e) => {
    const p = e.payload as { isPaused?: boolean; active?: number } | undefined;
    return p?.isPaused === true || p?.active === 0;
  })), ...ids(metricEvs)];

  steps.push({
    role: 'trigger',
    label: queueName
      ? `Workers consuming "${queueName}" stalled or processing slowly`
      : 'Workers stalled or processing slowly',
    evidenceIds: triggerEvIds.length > 0 ? triggerEvIds : ids(queueStateEvs),
    graphNodeId: workerNodeId,
  });

  if (queueStateEvs.length > 0) {
    steps.push({
      role: 'propagation',
      label: `Queue depth accumulating${queueName ? ` on "${queueName}"` : ''}`,
      evidenceIds: ids(queueStateEvs),
      graphNodeId: queueNodeId,
    });
  }

  if (logEvs.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Downstream latency and error signatures observed',
      evidenceIds: ids(logEvs),
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  const summary =
    'Worker stall on ' + (queueName ? `"${queueName}"` : 'queue') +
    ' → queue depth growing' +
    (logEvs.length > 0 ? ' → downstream errors' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps, summary };
}

function chainForExternalApiLatency(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
): CauseChain {
  const metricEvs = byKind.get('metric') ?? [];
  const logEvs = byKind.get('log') ?? [];
  const queueStateEvs = byKind.get('queue-state') ?? [];

  const steps: CauseChainStep[] = [];

  steps.push({
    role: 'trigger',
    label: `External or upstream dependency latency spike (${metricEvs.length} metric signal(s))`,
    evidenceIds: ids(metricEvs),
    graphNodeId: firstImplicatedNode(graph, 'service'),
  });

  if (logEvs.length > 0) {
    steps.push({
      role: 'propagation',
      label: 'Calls to upstream timing out or returning errors',
      evidenceIds: ids(logEvs),
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  if (queueStateEvs.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Queue backlog accumulating from stalled downstream workers',
      evidenceIds: ids(queueStateEvs),
      graphNodeId: firstImplicatedNode(graph, 'queue'),
    });
  }

  const summary =
    'External API latency spike' +
    (logEvs.length > 0 ? ' → timeout errors propagating' : '') +
    (queueStateEvs.length > 0 ? ' → queue backlog' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps, summary };
}

function chainForInfrastructure(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
): CauseChain {
  const stateEvs = byKind.get('state') ?? [];
  const queueStateEvs = byKind.get('queue-state') ?? [];
  const logEvs = byKind.get('log') ?? [];
  const metricEvs = byKind.get('metric') ?? [];

  const triggerEvIds = [...ids(stateEvs), ...ids(metricEvs)];
  const propagationEvIds = [...ids(queueStateEvs)];
  const symptomEvIds = ids(logEvs);

  const steps: CauseChainStep[] = [];

  steps.push({
    role: 'trigger',
    label: 'Infrastructure component degraded (database, network, or cache)',
    evidenceIds: triggerEvIds.length > 0 ? triggerEvIds : ids(queueStateEvs),
    graphNodeId:
      firstImplicatedNode(graph, 'collection') ??
      firstImplicatedNode(graph, 'database') ??
      firstImplicatedNode(graph, 'queue'),
  });

  if (propagationEvIds.length > 0) {
    steps.push({
      role: 'propagation',
      label: 'Dependent services / workers lost access to the degraded component',
      evidenceIds: propagationEvIds,
      graphNodeId: firstImplicatedNode(graph, 'worker') ?? firstImplicatedNode(graph, 'service'),
    });
  }

  if (symptomEvIds.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Processing failures and error signatures observed',
      evidenceIds: symptomEvIds,
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  const summary =
    'Infrastructure degradation → services/workers affected' +
    (symptomEvIds.length > 0 ? ' → processing failures' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps, summary };
}

function chainForRetryStorm(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
): CauseChain {
  const logEvs = byKind.get('log') ?? [];
  const queueStateEvs = byKind.get('queue-state') ?? [];
  const metricEvs = byKind.get('metric') ?? [];

  const steps: CauseChainStep[] = [];

  steps.push({
    role: 'trigger',
    label: `Initial failure with automatic retry enabled (${logEvs.length} log signature(s) spiking)`,
    evidenceIds: ids(logEvs),
    graphNodeId: firstImplicatedNode(graph, 'service'),
  });

  if (queueStateEvs.length > 0) {
    steps.push({
      role: 'propagation',
      label: 'Retry amplification growing queue depth and error volume',
      evidenceIds: ids(queueStateEvs),
      graphNodeId: firstImplicatedNode(graph, 'queue'),
    });
  }

  if (metricEvs.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Cascading load visible in metric anomalies',
      evidenceIds: ids(metricEvs),
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  const summary =
    'Initial failure + retry → amplified load' +
    (metricEvs.length > 0 ? ' → cascading metric anomalies' : '');

  return { hypothesisId: hyp.id, category: hyp.category, confidence: hyp.confidence, steps, summary };
}

function chainGeneric(
  hyp: ValidatedHypothesis,
  byKind: EvidenceByKind,
  graph: InvestigationGraph,
): CauseChain {
  // Fallback: group all supporting evidence into trigger + symptom
  const allEvIds = hyp.supportingEvidenceIds;
  const logOrMetric = [
    ...(byKind.get('log') ?? []),
    ...(byKind.get('metric') ?? []),
  ];

  const steps: CauseChainStep[] = [
    {
      role: 'trigger',
      label: hyp.statement,
      evidenceIds: allEvIds,
      graphNodeId: firstImplicatedNode(graph, 'service') ?? firstImplicatedNode(graph, 'queue'),
    },
  ];

  if (logOrMetric.length > 0) {
    steps.push({
      role: 'symptom',
      label: 'Observable symptoms in logs / metrics',
      evidenceIds: ids(logOrMetric),
      graphNodeId: firstImplicatedNode(graph, 'service'),
    });
  }

  return {
    hypothesisId: hyp.id,
    category: hyp.category,
    confidence: hyp.confidence,
    steps,
    summary: hyp.statement,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build causal chains for all `supported` and `weakened` hypotheses.
 *
 * Each chain maps the hypothesis category to a template of causal steps
 * (trigger → propagation → symptom [→ impact]) and populates each step with
 * the evidence IDs from the hypothesis's supporting set, categorised by kind.
 *
 * Chains for `unconfirmed` and `eliminated` hypotheses are omitted — there is
 * not enough evidence to narrate a causal sequence for them.
 *
 * The `seedLabel` and `graph` parameters are used to add human-readable context
 * (e.g. the seed symbol name) and optional graph node references to each step.
 */
export function buildCauseChains(
  hypotheses: ValidatedHypothesis[],
  evidence: Evidence[],
  graph: InvestigationGraph,
  seedLabel: string,
): CauseChain[] {
  const evById = new Map(evidence.map((e) => [e.id, e]));
  const chains: CauseChain[] = [];

  for (const hyp of hypotheses) {
    if (hyp.verdict !== 'supported' && hyp.verdict !== 'weakened') continue;

    const byKind = groupByKind(hyp.supportingEvidenceIds, evById);

    let chain: CauseChain;
    switch (hyp.category) {
      case 'deployment-regression':
        chain = chainForDeploymentRegression(hyp, byKind, graph, seedLabel);
        break;
      case 'queue-backlog': {
        const queueName = extractQueueName(hyp.statement);
        chain = chainForQueueBacklog(hyp, byKind, graph, queueName);
        break;
      }
      case 'worker-slowdown': {
        const queueName = extractQueueName(hyp.statement);
        chain = chainForWorkerSlowdown(hyp, byKind, graph, queueName);
        break;
      }
      case 'external-api-latency':
        chain = chainForExternalApiLatency(hyp, byKind, graph);
        break;
      case 'infrastructure':
        chain = chainForInfrastructure(hyp, byKind, graph);
        break;
      case 'retry-storm':
        chain = chainForRetryStorm(hyp, byKind, graph);
        break;
      default:
        chain = chainGeneric(hyp, byKind, graph);
    }

    chains.push(chain);
  }

  return chains;
}

/**
 * Extract queue name from a hypothesis statement like:
 * "A backlog on payments — producers enqueue faster than the worker drains."
 * Returns undefined if no queue name found.
 */
function extractQueueName(statement: string): string | undefined {
  const m = /\bon ([a-zA-Z0-9_-]+)/.exec(statement) ??
            /consuming ([a-zA-Z0-9_-]+)/.exec(statement);
  return m?.[1];
}
