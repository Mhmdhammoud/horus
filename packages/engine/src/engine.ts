/**
 * The deterministic investigation pipeline (HOR-5). NO AI/LLM.
 *
 * Given a free-text hint, it resolves seed symbols via the code provider, gathers
 * structural context (callers/callees, impact blast radius, execution flows, queue
 * boundaries, and optionally a change range), distills typed Evidence, derives
 * deterministic findings + ranked suspected causes, and persists everything.
 *
 * Determinism is a hard requirement: identical inputs and provider responses must
 * produce the same report (modulo generated UUIDs and timestamps).
 */

import type {
  ChangeSet,
  Evidence,
  EvidenceKind,
  EvidenceLinks,
  ImpactResult,
  ProviderKind,
  Symbol,
  SymbolContext,
} from '@horus/core';
import type {
  CodeProvider,
  LogsProvider,
  LogAnalysis,
  StateProvider,
  StateAnalysis,
  QueueRuntimeProvider,
  QueueRuntimeState,
  MetricsProvider,
} from '@horus/connectors';
import { shortTs, selectStateSignals, tokenize, analyzeQueueRuntime } from '@horus/connectors';
import { estimateOwnership } from './ownership.js';
import type { OwnershipEstimate } from './ownership.js';
import type { HorusDb, QueueEdge } from '@horus/db';
import {
  evidence as evidenceTable,
  findings as findingsTable,
  hypotheses as hypothesesTable,
  investigations as investigationsTable,
  listQueueEdges,
  eq,
} from '@horus/db';
import { buildGraph } from './graph.js';
import { rankCauses, type CauseInput } from './score-cause.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';
import { recallSimilar, storeIncidentMemory, deriveTags } from './memory.js';
import { detectMissingEvidence, type ConnectorFlags } from './gaps.js';
import type {
  InvestigationInput,
  InvestigationReport,
  ReportFinding,
} from './types.js';
import { buildTimeline } from './timeline.js';
import { correlate } from './correlate.js';
import { rankSeeds } from './seeds.js';
import { normalizeEvidence } from './normalize.js';

/** Dependencies the engine needs: a code provider and a database handle. */
export interface EngineDeps {
  code: CodeProvider;
  db: HorusDb;
  /** Optional Elasticsearch logs provider — when absent the investigation runs Axon-only. */
  logs?: LogsProvider | null;
  /** Optional MongoDB state provider — folds application-state anomalies as evidence. */
  mongo?: StateProvider | null;
  /** Optional BullMQ queue runtime provider — folds queue depth/failure evidence. */
  queue?: QueueRuntimeProvider | null;
  /** Optional Grafana metrics provider — folds anomaly evidence + clears metrics gap (HOR-40). */
  metrics?: MetricsProvider | null;
  /** Absolute path to the local git repository — enables ownership estimation (HOR-40). */
  repoPath?: string;
  /** Which connectors are configured for the env — drives honest gap text. */
  connectors?: ConnectorFlags;
}

/** Map an evidence kind to its originating provider. */
function sourceForKind(kind: EvidenceKind): ProviderKind {
  switch (kind) {
    case 'queue-edge':
    case 'queue-state':
      return 'queue';
    case 'commit':
      return 'history';
    case 'log':
      return 'logs';
    case 'metric':
      return 'metrics';
    case 'redis-key':
    case 'state':
      return 'state';
    default:
      return 'code';
  }
}

/** Clamp a number into the inclusive [0, 1] range. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Heuristic relevance per kind, kept deterministic. */
function relevanceForKind(kind: EvidenceKind): number {
  switch (kind) {
    case 'symbol':
      return 0.9;
    case 'impact':
      return 0.7;
    case 'queue-edge':
      return 0.75;
    case 'flow':
      return 0.6;
    case 'commit':
      return 0.65;
    case 'log':
      return 0.5;
    default:
      return 0.5;
  }
}

/**
 * Compute the start of the log query window from `since`.
 * Accepts duration strings like 24h, 7d, 30m, 90s; anything else defaults to
 * 7 days ago. Returns an ISO-8601 timestamp.
 */
export function logWindowFrom(since: string | undefined): string {
  const DURATION_RE = /^(\d+)([smhd])$/;
  const now = Date.now();
  if (since !== undefined) {
    const m = DURATION_RE.exec(since.trim());
    if (m !== null) {
      const value = Number(m[1]);
      const unit = m[2] as 's' | 'm' | 'h' | 'd';
      const msMap: Record<typeof unit, number> = {
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
      };
      return new Date(now - value * msMap[unit]).toISOString();
    }
  }
  // Default: 7 days ago
  return new Date(now - 7 * 86_400_000).toISOString();
}

/**
 * Derive the confidence for the queue-runtime anomaly finding.
 * Exported for unit testing — logic must stay in sync with the inline usage below.
 *
 * Rule: starvation-only (no pure-backlog queues) → 0.65 (hedged single snapshot).
 * Any pure backlog or failure → 0.85 (higher certainty from depth counts).
 */
export function queueFindingConfidence(opts: {
  starvedCount: number;
  backloggedCount: number;
  failingCount: number;
}): number {
  const { starvedCount, backloggedCount, failingCount } = opts;
  return starvedCount > 0 && backloggedCount === 0 && failingCount === 0 ? 0.65 : 0.85;
}

/** Does `since` look like a range or a concrete ref worth diffing? */
function looksDiffable(since: string): boolean {
  const s = since.trim();
  if (s.length === 0) return false;
  if (s.includes('..')) return true;
  // A bare ref (tag, branch, sha) is also diffable against HEAD.
  return /^[A-Za-z0-9._/-]+$/.test(s);
}

export async function investigate(
  input: InvestigationInput,
  deps: EngineDeps,
): Promise<InvestigationReport> {
  const { code, db } = deps;

  // a. PARSE
  const hint = input.hint.trim();

  // Evidence accumulator + factory. ids double as the persisted PKs.
  const evidence: Evidence[] = [];
  const collectedAt = new Date().toISOString();
  function mkEv(
    kind: EvidenceKind,
    title: string,
    payload: unknown,
    links: EvidenceLinks,
    timestamp?: string,
    relevance?: number,
  ): Evidence {
    const ev: Evidence = {
      id: globalThis.crypto.randomUUID(),
      source: sourceForKind(kind),
      kind,
      title,
      relevance: relevance !== undefined ? relevance : relevanceForKind(kind),
      payload,
      links,
      provenance: { query: hint, collectedAt },
    };
    if (timestamp !== undefined) ev.timestamp = timestamp;
    evidence.push(ev);
    return ev;
  }

  // b. RESOLVE seeds — rank candidates so we prefer architectural entry points
  // (resolver/controller/service/route) over tiny helpers/scripts (HOR-39).
  const rawSeeds = await code.searchSymbols(hint, 5);
  const ranked = rankSeeds(rawSeeds);
  const seeds = ranked.map((r) => r.symbol);
  // noUncheckedIndexedAccess: a non-empty array could still index to undefined.
  const top = seeds[0];

  if (!top) {
    const report: InvestigationReport = {
      id: globalThis.crypto.randomUUID(),
      input,
      summary: 'No source symbols matched the hint',
      seeds: [],
      evidence: [],
      timeline: { events: [], boundaryCrossings: [] },
      correlation: { groups: [], chains: [], missing: correlate([]).missing },
      findings: [],
      suspectedCauses: [],
      hypotheses: [],
      similarIncidents: [],
      gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 0 },
      graph: { nodes: [], edges: [] },
      confidence: 0,
      nextActions: [
        `No symbols matched "${hint}". Try a more specific hint — an exact function, class, or file name.`,
      ],
    };
    const persistedId = await persist(db, input, report);
    if (persistedId) report.id = persistedId;
    return report;
  }

  // A "constructor" seed is really its class — surface a friendlier label in the report.
  const label =
    top.name === 'constructor'
      ? `${(top.id.split(':').pop() ?? '').replace(/\.constructor$/, '') || top.name} (constructor)`
      : top.name;

  // c. GATHER
  const [ctx, impact, flows] = await Promise.all([
    code.context(top.id),
    code.impact(top.id, 2),
    code.flowsFor(top.id),
  ]);
  const edges = await listQueueEdges(db, { project: input.repo });

  const symbolNames = new Set<string>([
    top.name,
    ...ctx.callers.map((s) => s.name),
    ...ctx.callees.map((s) => s.name),
  ]);
  const queueHits: QueueEdge[] = edges.filter((e) => {
    const bySymbol =
      (e.producerSymbol !== null && symbolNames.has(e.producerSymbol)) ||
      (e.workerSymbol !== null && symbolNames.has(e.workerSymbol));
    const byFile =
      e.producerFile === top.filePath || e.workerFile === top.filePath;
    return bySymbol || byFile;
  });

  let changes: ChangeSet | null = null;
  if (input.since !== undefined && looksDiffable(input.since)) {
    try {
      changes = await code.detectChanges({ base: input.since, compare: 'HEAD' });
    } catch {
      changes = null;
    }
  }

  // d. BUILD Evidence
  const seedLine = top.startLine ?? 0;
  const seedEv = mkEv(
    'symbol',
    `Seed symbol ${top.name} (${top.filePath}:${seedLine})`,
    { symbol: top, snippet: ctx.snippet ?? null },
    { symbolId: top.id, file: top.filePath, line: seedLine },
  );

  const flowEvIds: string[] = [];
  for (const flow of flows) {
    const ev = mkEv(
      'flow',
      `Flow "${flow.name}" (${flow.steps.length} step(s))`,
      { flowId: flow.id, name: flow.name, steps: flow.steps.map((s) => s.name) },
      { symbolId: top.id, file: top.filePath },
    );
    flowEvIds.push(ev.id);
  }

  const impactEv = mkEv(
    'impact',
    `Impact of ${top.name}: ${impact.affected} affected symbol(s)`,
    { affected: impact.affected },
    { symbolId: top.id, file: top.filePath },
  );

  // One queue-edge evidence per hit; track ids per distinct queue for findings/causes.
  const queueEvByName = new Map<string, string[]>();
  for (const edge of queueHits) {
    const producer = edge.producerSymbol ?? 'unknown-producer';
    const worker = edge.workerSymbol ?? 'unknown-worker';
    const ev = mkEv(
      'queue-edge',
      `Queue "${edge.queueName}": ${producer} -> ${worker}`,
      {
        queueName: edge.queueName,
        producerSymbol: edge.producerSymbol,
        producerFile: edge.producerFile,
        workerSymbol: edge.workerSymbol,
        workerFile: edge.workerFile,
        source: edge.source,
      },
      { queueName: edge.queueName },
    );
    const list = queueEvByName.get(edge.queueName) ?? [];
    list.push(ev.id);
    queueEvByName.set(edge.queueName, list);
  }

  let changeEvId: string | null = null;
  if (changes) {
    const addedN = changes.added.length;
    const removedN = changes.removed.length;
    const modifiedN = changes.modified.length;
    const ev = mkEv(
      'commit',
      `Change range ${input.since}..HEAD: +${addedN} -${removedN} ~${modifiedN} symbol(s)`,
      { added: addedN, removed: removedN, modified: modifiedN },
      {},
    );
    changeEvId = ev.id;
  }

  // e0. RUNTIME LOG EVIDENCE (HOR-10/13) — synthesize error SIGNATURES, not raw log
  // dumps. Optional; never breaks the investigation on failure.
  let analysis: LogAnalysis | null = null;
  const logEvIds: string[] = [];

  if (deps.logs) {
    try {
      const from = logWindowFrom(input.since);
      // Error signatures are scoped by service + window, NOT by the hint text:
      // the errors that matter to an incident rarely contain the hint words in
      // their message (the hint resolves the code seed; the service scopes logs).
      analysis = await deps.logs.analyzeErrors({ service: input.service, from });

      for (const s of analysis.signatures.slice(0, 15)) {
        const tags: string[] = [];
        if (s.isNew) tags.push('NEW');
        else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
          tags.push(`spike x${s.ratio.toFixed(1)}`);
        }
        const svc = s.services.length > 0 ? ` · ${s.services.slice(0, 3).join(', ')}` : '';
        const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
        const ev = mkEv(
          'log',
          `Error ${s.key}: ${s.count}x (first ${shortTs(s.firstSeen)}, last ${shortTs(s.lastSeen)})${svc}${tagStr}`.slice(
            0,
            180,
          ),
          {
            signature: s.key,
            count: s.count,
            firstSeen: s.firstSeen,
            lastSeen: s.lastSeen,
            services: s.services,
            isNew: s.isNew ?? false,
            ratio: s.ratio ?? null,
            sampleMessage: s.sampleMessage ?? null,
          },
          {},
          s.lastSeen || undefined,
          s.isNew ? 0.95 : s.ratio !== undefined && s.ratio >= 1.5 ? 0.9 : 0.8,
        );
        // Normalize recurrence signals to top-level Evidence fields so the
        // Cause Scoring Engine can read them without inspecting the payload.
        if (s.isNew) ev.isNew = s.isNew;
        if (typeof s.ratio === 'number' && Number.isFinite(s.ratio)) ev.ratio = s.ratio;
        logEvIds.push(ev.id);
      }
    } catch {
      // Logs failure must never break the investigation — continue without log evidence.
      analysis = null;
    }
  }

  // e0b. MONGODB STATE (HOR-33) — application-state anomalies as evidence. Optional;
  // never breaks the investigation on failure. Counts/state only — no raw documents.
  let stateAnalysis: StateAnalysis | null = null;
  const stateEvIds: string[] = [];
  const stateCollections = new Set<string>();

  if (deps.mongo) {
    try {
      stateAnalysis = await deps.mongo.analyzeState();
      // Relevance terms: the hint + the resolved seed's name and file basename, so
      // unrelated stale/legacy collections don't dominate (HOR-39).
      const seedBase = top.filePath.split('/').pop() ?? '';
      const terms = [
        ...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(seedBase)]),
      ];
      for (const s of selectStateSignals(stateAnalysis, terms)) {
        const ev = mkEv('state', s.title, s.payload, {}, s.timestamp, s.relevance);
        stateEvIds.push(ev.id);
        stateCollections.add(s.collection);
      }
    } catch {
      stateAnalysis = null;
    }
  }

  // e0c. QUEUE RUNTIME STATE (HOR-12) — backlog, failures, starvation as evidence.
  // Scoped to the queues that appear in the stitcher edges so we only query what's
  // relevant to this investigation. Optional; never breaks on failure.
  let queueRuntimeState: QueueRuntimeState | null = null;
  const queueRuntimeEvIds: string[] = [];
  // Per-queue evidence IDs so each suspected cause cites only its own queue's data.
  const queueRuntimeEvIdsByQueue = new Map<string, string[]>();
  // Typed by signal kind so hypotheses can cite only the relevant runtime signals.
  const queueBacklogEvIds: string[] = [];
  const queueStarvationEvIds: string[] = [];

  if (deps.queue && queueHits.length > 0) {
    try {
      const queueNames = [...new Set(queueHits.map((e) => e.queueName))];
      queueRuntimeState = await deps.queue.analyzeQueues({ queueNames });
      for (const s of analyzeQueueRuntime(queueRuntimeState)) {
        const ev = mkEv('queue-state', s.title, s.payload, { queueName: s.queueName }, s.timestamp, s.relevance);
        queueRuntimeEvIds.push(ev.id);
        if (s.kind === 'backlog') queueBacklogEvIds.push(ev.id);
        else if (s.kind === 'worker-starvation') queueStarvationEvIds.push(ev.id);
        const perQueue = queueRuntimeEvIdsByQueue.get(s.queueName) ?? [];
        perQueue.push(ev.id);
        queueRuntimeEvIdsByQueue.set(s.queueName, perQueue);
      }
    } catch {
      queueRuntimeState = null;
    }
  }

  // e0d. METRIC EVIDENCE (HOR-11 / HOR-40) — Grafana anomaly findings scoped by hint.
  // Optional; never breaks the investigation on failure.
  // Hard timeout keeps a slow/large Grafana from stalling the report.
  const METRICS_TIMEOUT_MS = 10_000;
  const metricEvIds: string[] = [];
  const latencyMetricEvIds: string[] = [];
  const queueMetricEvIds: string[] = [];
  let metricsCollected = false;

  if (deps.metrics) {
    const ac = new AbortController();
    let metricsTimerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const fromMs = new Date(logWindowFrom(input.since)).getTime();
      const toMs = Date.now();
      metricsTimerId = setTimeout(() => ac.abort(new Error('metrics timeout')), METRICS_TIMEOUT_MS);
      // unref() prevents the timer from keeping the Node process alive.
      (metricsTimerId as { unref?: () => void }).unref?.();
      const mFindings = await deps.metrics.analyze({
        hint: input.hint,
        from: Math.floor(fromMs / 1000),
        to: Math.floor(toMs / 1000),
        signal: ac.signal,
      });

      const mEvidence = deps.metrics.toEvidence(mFindings);
      const anomalous = mFindings.filter((f) => f.anomaly !== 'none');
      // findingsToEvidence produces sequential ev_metric_N ids; replace with UUIDs
      // so they are unique across investigations in the DB.
      // Correlate each anomaly to the implicated path before wiring to hypotheses:
      // queue-growth must reference a known queue name; latency/error-rate must match
      // the investigated service when one is given — without a service scope the
      // correlation is too loose to be causal evidence.
      const queueNamesSet = new Set(queueHits.map((e) => e.queueName.toLowerCase()));
      const serviceFilter = (input.service ?? '').toLowerCase();
      const collectedAt = new Date().toISOString();

      for (let i = 0; i < mEvidence.length; i++) {
        const ev = mEvidence[i];
        if (ev === undefined) continue;
        ev.id = globalThis.crypto.randomUUID();
        // Override sequential provenance with the actual investigation hint.
        ev.provenance = { query: hint, collectedAt };
        evidence.push(ev);
        metricEvIds.push(ev.id);

        const f = anomalous[i];
        if (f === undefined) continue;

        const panelLower = f.panelTitle.toLowerCase();
        const labelVals = Object.values(f.labels).map((v) => v.toLowerCase());

        if (f.anomaly === 'latency-spike' || f.anomaly === 'error-rate-change') {
          // Without a service scope, retain as evidence but don't boost hypotheses.
          const relevant =
            serviceFilter.length > 0 &&
            (panelLower.includes(serviceFilter) || labelVals.some((v) => v.includes(serviceFilter)));
          if (relevant) latencyMetricEvIds.push(ev.id);
        } else if (f.anomaly === 'queue-growth') {
          // Only boost worker-slowdown when a queue name from the implicated edges
          // appears in the panel title or labels.
          const relevant =
            queueNamesSet.size > 0 &&
            [...queueNamesSet].some(
              (q) => panelLower.includes(q) || labelVals.some((v) => v.includes(q)),
            );
          if (relevant) queueMetricEvIds.push(ev.id);
        }
      }
      // Set only after the full collection + conversion loop completes without error.
      metricsCollected = true;
    } catch {
      // Metrics failure (including timeout) must never break the investigation.
      // metricsCollected stays false — gap detector will report the failure.
    } finally {
      // Always clear the timer to prevent it from firing after a fast response
      // and to release the reference regardless of the outcome.
      if (metricsTimerId !== undefined) clearTimeout(metricsTimerId);
    }
  }

  // e0e. OWNERSHIP (HOR-20 / HOR-40) — estimate likely maintainer from git history.
  // Reuses the already-resolved seed symbol to skip a duplicate Axon search.
  // Optional; only runs when repoPath is configured. Never breaks on failure.
  let ownershipEstimate: OwnershipEstimate | null = null;
  if (deps.repoPath) {
    try {
      ownershipEstimate = await estimateOwnership(top.name, {
        code: deps.code,
        repoPath: deps.repoPath,
        symbol: top,
      });
    } catch {
      ownershipEstimate = null;
    }
  }

  // e0f. NORMALIZE — fill in cross-provider priority + category before any
  // downstream step reads them. Idempotent; safe to call even if a provider
  // failed and contributed zero items.
  normalizeEvidence(evidence);

  // e0g. GRAPH — derive infrastructure topology from normalized evidence. Built
  // here so implication scores are available when scoring suspected causes below.
  const graph = buildGraph(evidence);

  // e. TIMELINE (deterministic; built after all evidence is accumulated)
  const timeline = buildTimeline(evidence);

  // e2. CORRELATION (deterministic grouping + cause chains + missing evidence)
  const correlation = correlate(evidence);

  // e3. HYPOTHESES (HOR-24) — deterministic competing set
  const queueNames = [...queueEvByName.keys()];
  const hyps = generateHypotheses(evidence, correlation, {
    seedLabel: label,
    queues: queueNames,
    latencyMetricEvIds,
    queueMetricEvIds,
    queueBacklogEvIds,
    queueStarvationEvIds,
  });

  // e4. HYPOTHESIS VALIDATION (HOR-25) — adjust confidence + assign verdicts
  const validated = validateHypotheses(hyps, evidence);

  // f. FINDINGS (label kept as 'e' externally but shifted to 'f' internally)
  const findings: ReportFinding[] = [];

  // The seed is the best-ranked candidate (architectural entry point preferred).
  findings.push({
    kind: 'observation',
    title: `Seed resolves to ${label} at ${top.filePath}:${seedLine}`,
    detail: top.signature ?? undefined,
    confidence: 1,
    evidenceIds: [seedEv.id],
  });

  // Surface the other ranked candidate areas so a narrow pick is transparent.
  if (ranked.length > 1) {
    const candidates = ranked
      .slice(0, 4)
      .map((r) => `${r.symbol.name} [${r.role}]`)
      .join(', ');
    findings.push({
      kind: 'observation',
      title: `Candidate areas (ranked): ${candidates}`,
      detail: `Investigating ${label} [${ranked[0]?.role}]; re-run with a more specific hint to target another.`,
      confidence: 0.5,
      evidenceIds: [seedEv.id],
    });
  }

  if (flows.length > 0) {
    findings.push({
      kind: 'observation',
      title: `Participates in ${flows.length} execution flow(s)`,
      detail: flows.map((f) => f.name).join(', ') || undefined,
      confidence: clamp01(0.5 + flows.length * 0.1),
      evidenceIds: flowEvIds,
    });
  }

  if (impact.affected > 0) {
    findings.push({
      kind: 'observation',
      title: `Changing ${top.name} impacts ${impact.affected} symbol(s) (blast radius)`,
      confidence: clamp01(0.4 + Math.min(impact.affected, 20) / 40),
      evidenceIds: [impactEv.id],
    });
  }

  for (const [queueName, evIds] of queueEvByName) {
    const edge = queueHits.find((e) => e.queueName === queueName);
    const producer = edge?.producerSymbol ?? 'unknown-producer';
    const worker = edge?.workerSymbol ?? 'unknown-worker';
    findings.push({
      kind: 'correlation',
      title: `Crosses a queue boundary: ${queueName} (${producer} -> ${worker})`,
      confidence: 0.7,
      evidenceIds: evIds,
    });
  }

  if (changes && changeEvId) {
    const m =
      changes.added.length + changes.removed.length + changes.modified.length;
    findings.push({
      kind: 'observation',
      title: `${m} symbol(s) changed in range ${input.since}..HEAD`,
      confidence: clamp01(0.4 + Math.min(m, 20) / 40),
      evidenceIds: [changeEvId],
    });
  }

  // Runtime error-signature findings (only when log evidence was synthesized)
  if (analysis !== null && analysis.signatures.length > 0) {
    const newN = analysis.newSignatures.length;
    const affected =
      analysis.affectedServices.length > 0
        ? analysis.affectedServices.join(', ')
        : (input.service ?? 'the service');
    findings.push({
      kind: 'observation',
      title: `${analysis.signatures.length} error signature(s) (${newN} new, ${analysis.totalErrors} error(s)) — affected: ${affected}`,
      confidence: 0.65,
      evidenceIds: logEvIds,
    });

    const top = analysis.signatures[0];
    if (top !== undefined) {
      const flag = top.isNew
        ? ' (NEW)'
        : top.ratio !== undefined && Number.isFinite(top.ratio) && top.ratio >= 1.5
          ? ` (spike x${top.ratio.toFixed(1)})`
          : '';
      findings.push({
        kind: 'anomaly',
        title: `Top error signature: ${top.key} — ${top.count}x${flag}, last ${shortTs(top.lastSeen)}`,
        confidence: 0.7,
        evidenceIds: logEvIds.slice(0, 1),
      });
    }
  }

  // Application-state findings (MongoDB, HOR-33)
  if (stateAnalysis !== null && stateEvIds.length > 0) {
    findings.push({
      kind: 'anomaly',
      title: `Application state: ${stateEvIds.length} relevant signal(s) across ${stateCollections.size} collection(s) in ${stateAnalysis.database}`,
      confidence: 0.6,
      evidenceIds: stateEvIds,
    });
  }

  // Queue runtime findings (HOR-12)
  if (queueRuntimeState !== null && queueRuntimeEvIds.length > 0) {
    const starved = queueRuntimeState.queues.filter((q) => q.waiting >= 10 && q.active === 0);
    // Exclude starved queues: the analyzer emits worker-starvation instead of backlog for
    // them, so treating them as backlogged here would inflate finding confidence to 0.85.
    const starvedNames = new Set(starved.map((q) => q.queueName));
    const backlogged = queueRuntimeState.queues.filter(
      (q) => q.waiting > 100 && !starvedNames.has(q.queueName),
    );
    const failing = queueRuntimeState.queues.filter((q) => q.failed > 20);

    if (backlogged.length > 0 || starved.length > 0 || failing.length > 0) {
      const parts: string[] = [];
      if (starved.length > 0)
        parts.push(
          `possible starvation: ${starved.map((q) => q.queueName).join(', ')} (0 active workers in snapshot)`,
        );
      if (backlogged.length > 0)
        parts.push(
          `backlog: ${backlogged.map((q) => `${q.queueName} (${q.waiting})`).join(', ')}`,
        );
      if (failing.length > 0)
        parts.push(`failures: ${failing.map((q) => `${q.queueName} (${q.failed})`).join(', ')}`);
      findings.push({
        kind: 'anomaly',
        title: `Queue runtime anomalies — ${parts.join('; ')}`,
        confidence: queueFindingConfidence({
          starvedCount: starved.length,
          backloggedCount: backlogged.length,
          failingCount: failing.length,
        }),
        evidenceIds: queueRuntimeEvIds,
      });
    } else {
      const summary = queueRuntimeState.queues
        .map((q) => `${q.queueName}: ${q.waiting} waiting`)
        .join(', ');
      findings.push({
        kind: 'observation',
        title: `Queue runtime healthy — ${summary}`,
        confidence: 0.5,
        evidenceIds: queueRuntimeEvIds,
      });
    }
  }

  // Metric findings (HOR-40)
  if (metricEvIds.length > 0) {
    const anomalyLabels: string[] = [];
    if (latencyMetricEvIds.length > 0) anomalyLabels.push('latency/error-rate');
    if (queueMetricEvIds.length > 0) anomalyLabels.push('queue-growth');
    const desc = anomalyLabels.join(', ') || 'metric';
    findings.push({
      kind: 'anomaly',
      title: `Metric anomalies: ${metricEvIds.length} signal(s) — ${desc}`,
      confidence: 0.7,
      evidenceIds: metricEvIds,
    });
  }

  // f. SUSPECTED CAUSES — build CauseInput list; scoring + ranking via rankCauses (HOR-15).
  const causeInputs: CauseInput[] = [];
  const blastRadius = impact.affected;

  // Queue runtime causes: backlog and starvation elevate the queue-path hypothesis.
  if (queueRuntimeState !== null) {
    for (const q of queueRuntimeState.queues) {
      const isStarved = q.waiting >= 10 && q.active === 0;
      const isBacklogged = q.waiting > 100;
      if (isStarved || isBacklogged) {
        const edge = queueHits.find((e) => e.queueName === q.queueName);
        const producer = edge?.producerSymbol ?? 'producer';
        const worker = edge?.workerSymbol ?? 'worker';
        const detail = isStarved
          ? `${q.waiting} waiting, no active workers`
          : `${q.waiting} waiting jobs`;
        causeInputs.push({
          id: `cause:queue-backlog:${q.queueName}`,
          title: `Queue "${q.queueName}" is backed up (${detail}) — ${producer} → ${worker} path implicated`,
          category: 'queue-backlog',
          sourceEvidenceIds: queueRuntimeEvIdsByQueue.get(q.queueName) ?? [],
          baseScore: clamp01(isStarved ? 0.45 : 0.45 + Math.min(q.waiting / 5_000, 0.20)),
          metadata: { waitingCount: q.waiting, isStarved, blastRadius },
        });
      }
    }
  }

  // Queue-path cause(s) — structural; runtime evidence needed to elevate to likely.
  for (const [queueName, evIds] of queueEvByName) {
    const edge = queueHits.find((e) => e.queueName === queueName);
    const producer = edge?.producerSymbol ?? 'unknown-producer';
    const worker = edge?.workerSymbol ?? 'unknown-worker';
    causeInputs.push({
      id: `cause:queue-path:${queueName}`,
      title: `The ${queueName} processing path (${producer} -> ${worker}) is implicated`,
      category: 'queue-path',
      sourceEvidenceIds: [...evIds, impactEv.id],
      baseScore: 0.35,
      metadata: { blastRadius },
    });
  }

  if (changes && changeEvId) {
    causeInputs.push({
      id: 'cause:deployment-regression',
      title: `Recent change to ${top.name} in ${input.since}..HEAD may have introduced the regression`,
      category: 'deployment-regression',
      sourceEvidenceIds: [changeEvId, seedEv.id],
      baseScore: clamp01(0.25 + (queueHits.length > 0 ? 0.05 : 0)),
      metadata: { blastRadius },
    });
  }

  // Blast-radius cause: always offered when the symbol has reach.
  if (impact.affected > 0) {
    causeInputs.push({
      id: 'cause:blast-radius',
      title: `${top.name} sits on a high-fan-out path (${impact.affected} affected) and may propagate the fault`,
      category: 'blast-radius',
      sourceEvidenceIds: [impactEv.id, seedEv.id],
      baseScore: clamp01(0.15 + (queueHits.length > 0 ? 0.05 : 0)),
      metadata: { blastRadius },
    });
  }

  // Runtime-errors + queue-path cause: only when we have error evidence AND a queue path.
  if (analysis !== null && analysis.signatures.length > 0 && queueHits.length > 0) {
    const firstQueue = queueHits[0];
    const queueLabel =
      firstQueue !== undefined
        ? `"${firstQueue.queueName}" (${firstQueue.producerSymbol ?? 'unknown'} -> ${firstQueue.workerSymbol ?? 'unknown'})`
        : 'the queue path';
    const topSig = analysis.signatures[0];
    causeInputs.push({
      id: 'cause:error-correlation',
      title: `Runtime errors (${analysis.totalErrors}${topSig ? `, top ${topSig.key}` : ''}) correlate with the implicated queue path ${queueLabel}`,
      category: 'error-correlation',
      sourceEvidenceIds: logEvIds.slice(0, 3),
      baseScore: 0.30,
      metadata: { blastRadius },
    });
  }

  // Metric-driven causes (HOR-40): latency/error-rate anomalies → external-api-latency cause.
  if (latencyMetricEvIds.length > 0) {
    causeInputs.push({
      id: 'cause:metric-latency',
      title: `Metric anomalies (${latencyMetricEvIds.length} latency/error-rate signal(s)) — upstream dependency or component under load`,
      category: 'external-api-latency',
      sourceEvidenceIds: latencyMetricEvIds,
      baseScore: 0.45,
      metadata: { blastRadius },
    });
  }

  // Metric-driven causes (HOR-40): queue-growth anomaly → queue-backlog cause.
  if (queueMetricEvIds.length > 0) {
    causeInputs.push({
      id: 'cause:metric-queue-growth',
      title: `Queue-growth metric anomalies (${queueMetricEvIds.length} signal(s)) — worker throughput may be insufficient`,
      category: 'queue-backlog',
      sourceEvidenceIds: queueMetricEvIds,
      baseScore: 0.40,
      metadata: { blastRadius },
    });
  }

  // Score + rank via the Cause Scoring Engine — graph proximity, evidence quality,
  // source diversity, recency, recurrence, blast radius, and finding
  // corroboration applied as factors.
  // Keys must match Evidence.source values (not provider .id) — see factorProviderReliability.
  const providerReliability: Record<string, number> = {
    code: 0.80,
    ...(deps.logs != null ? { logs: 0.70 } : {}),
    ...(deps.mongo != null ? { state: 0.85 } : {}),
    ...(deps.queue != null ? { queue: 0.90 } : {}),
    ...(deps.metrics != null ? { metrics: 0.75 } : {}),
  };
  const rankedCauses = rankCauses(causeInputs, {
    evidence,
    graph,
    findings,
    providerReliability,
    request: { hint: input.hint, service: input.service },
  });

  // g. confidence — runtime evidence (observational) weighted 3× vs structural
  // (code graph) so that 8 symbol/flow items can't produce the same confidence
  // as 8 log/metric/queue-state anomalies.
  const weightedEvidenceSum = evidence.reduce((sum, e) => {
    // Observational (runtime) evidence is weighted higher than structural
    // (code-graph) evidence. 'redis-key' and 'state' are also runtime
    // observations captured from live system state.
    const isRuntime =
      e.kind === 'log' ||
      e.kind === 'metric' ||
      e.kind === 'commit' ||
      e.kind === 'queue-state' ||
      e.kind === 'redis-key' ||
      e.kind === 'state';
    return sum + (isRuntime ? 1.5 : 0.5);
  }, 0);
  const evidenceConfidence = clamp01(weightedEvidenceSum / 8);
  const seedResolved = seeds.length > 0 ? 1 : 0;
  const confidence = clamp01(0.5 * evidenceConfidence + 0.5 * seedResolved);

  // h. summary
  const area = ctx.community?.name ?? top.filePath;
  const topCause = rankedCauses[0];
  const summary = topCause
    ? `Investigation of "${hint}" resolved to ${label} (${area}). Top suspected cause: ${topCause.title}.`
    : `Investigation of "${hint}" resolved to ${label} (${area}). No dominant suspected cause emerged from the available structural evidence.`;

  // i. nextActions
  const nextActions = buildNextActions(top, ctx, impact, queueHits, changes, input);

  // Prepend owner routing when ownership is known (HOR-40).
  if (ownershipEstimate?.likelyMaintainer) {
    nextActions.unshift(
      `Route to likely maintainer: ${ownershipEstimate.likelyMaintainer} (${Math.round(ownershipEstimate.maintainerShare * 100)}% of commits to ${ownershipEstimate.file ?? top.filePath})`,
    );
  }

  const report: InvestigationReport = {
    id: globalThis.crypto.randomUUID(),
    input,
    summary,
    seeds,
    evidence,
    timeline,
    correlation,
    findings,
    suspectedCauses: rankedCauses,
    hypotheses: validated,
    similarIncidents: [],
    gapAnalysis: { gaps: [], blindSpots: [], confidenceCeiling: 1 },
    graph,
    confidence,
    nextActions,
    ownership: ownershipEstimate,
  };

  // HOR-19 — compute gap analysis and cap confidence BEFORE persisting so the
  // persisted record reflects the capped value.
  const connectorFlags: ConnectorFlags = deps.connectors
    ? { ...deps.connectors, metricsCollected }
    : {
        elasticsearch: deps.logs != null,
        mongodb: deps.mongo != null,
        grafana: deps.metrics != null,
        metricsCollected,
      };
  const gapAnalysis = detectMissingEvidence(report, connectorFlags);
  report.gapAnalysis = gapAnalysis;
  report.confidence = Math.min(report.confidence, gapAnalysis.confidenceCeiling);

  // j. PERSIST — may overwrite report.id with the DB-assigned id.
  const persistedId = await persist(db, input, report);
  if (persistedId) report.id = persistedId;

  // k. INCIDENT MEMORY (HOR-18) — recall similar past incidents THEN store.
  //    Past incidents are CONTEXT ONLY; they must never override report.confidence.
  if (persistedId !== null) {
    const tags = deriveTags(report);
    report.similarIncidents = await recallSimilar(db, tags, persistedId);
    await storeIncidentMemory(db, persistedId, report);
  }
  // If persist failed (db down / no id), similarIncidents stays [] and we skip store.

  // l. AUDIT BUNDLE (HOR-16) — write the fully-finalized report to the investigations row
  //    so it can be re-rendered later without re-querying production.
  if (persistedId !== null) {
    try {
      await db
        .update(investigationsTable)
        .set({ report: report })
        .where(eq(investigationsTable.id, persistedId));
    } catch {
      // Non-fatal: the investigation row already exists; the audit bundle is best-effort.
    }
  }

  return report;
}

/** Deterministic, name-bearing next-step suggestions. */
function buildNextActions(
  top: Symbol,
  _ctx: SymbolContext,
  impact: ImpactResult,
  queueHits: QueueEdge[],
  changes: ChangeSet | null,
  input: InvestigationInput,
): string[] {
  const actions: string[] = [];
  const seenQueues = new Set<string>();
  for (const edge of queueHits) {
    if (seenQueues.has(edge.queueName)) continue;
    seenQueues.add(edge.queueName);
    const worker = edge.workerSymbol ?? 'the consumer';
    actions.push(`Inspect logs for worker ${worker} on queue ${edge.queueName}`);
    actions.push(`Check depth/failures of queue ${edge.queueName}`);
  }
  if (impact.affected > 0) {
    actions.push(`Review impact set of ${top.name} (${impact.affected} affected symbol(s))`);
  }
  if (changes && input.since !== undefined) {
    actions.push(`Diff recent commits touching ${top.filePath} in ${input.since}..HEAD`);
  } else {
    actions.push(`Diff recent commits touching ${top.filePath}`);
  }
  if (actions.length === 0) {
    actions.push(`Inspect the source of ${top.name} at ${top.filePath}`);
  }
  return actions;
}

/**
 * Persist an investigation, its evidence, and findings. Never throws — if the DB is
 * down the investigation still returns. Returns the persisted investigation id when
 * available, else null.
 */
async function persist(
  db: HorusDb,
  input: InvestigationInput,
  report: InvestigationReport,
): Promise<string | null> {
  try {
    const inserted = await db
      .insert(investigationsTable)
      .values({
        title: input.hint.trim() || 'Investigation',
        incidentInput: input,
        status: 'open',
        summary: report.summary,
      })
      .returning({ id: investigationsTable.id });

    const row = inserted[0];
    if (!row) return null;
    const investigationId = row.id;

    if (report.evidence.length > 0) {
      await db.insert(evidenceTable).values(
        report.evidence.map((e) => ({
          id: e.id,
          investigationId,
          source: e.source,
          kind: e.kind,
          title: e.title,
          timestamp: e.timestamp ? new Date(e.timestamp) : null,
          relevance: e.relevance,
          payload: e.payload,
          links: e.links,
          provenance: e.provenance,
        })),
      );
    }

    if (report.findings.length > 0) {
      await db.insert(findingsTable).values(
        report.findings.map((f) => ({
          investigationId,
          kind: f.kind,
          title: f.title,
          detail: f.detail ?? null,
          confidence: f.confidence,
          evidenceIds: f.evidenceIds,
        })),
      );
    }

    if (report.hypotheses.length > 0) {
      await db.insert(hypothesesTable).values(
        report.hypotheses.map((hyp, i) => ({
          investigationId,
          rank: i + 1,
          statement: hyp.statement,
          score: hyp.confidence,
          supportingEvidence: hyp.supportingEvidenceIds,
          verdict: hyp.verdict,
        })),
      );
    }

    return investigationId;
  } catch {
    return null;
  }
}
