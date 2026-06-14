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
import type { CodeProvider, LogsProvider, LogRecord } from '@horus/connectors';
import type { HorusDb, QueueEdge } from '@horus/db';
import {
  evidence as evidenceTable,
  findings as findingsTable,
  hypotheses as hypothesesTable,
  investigations as investigationsTable,
  listQueueEdges,
  eq,
} from '@horus/db';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';
import { recallSimilar, storeIncidentMemory, deriveTags } from './memory.js';
import { detectMissingEvidence } from './gaps.js';
import type {
  InvestigationInput,
  InvestigationReport,
  ReportFinding,
  SuspectedCause,
} from './types.js';
import { buildTimeline } from './timeline.js';
import { correlate } from './correlate.js';

/** Dependencies the engine needs: a code provider and a database handle. */
export interface EngineDeps {
  code: CodeProvider;
  db: HorusDb;
  /** Optional Elasticsearch logs provider — when absent the investigation runs Axon-only. */
  logs?: LogsProvider | null;
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

  // b. RESOLVE seeds
  const seeds = await code.searchSymbols(hint, 5);
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
  const edges = await listQueueEdges(db);

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

  // e0. RUNTIME LOGS (HOR-13) — optional, never breaks the investigation on failure.
  let records: LogRecord[] = [];
  let buckets: { key: string; count: number }[] = [];
  let errorLogCount = 0;
  const logEvIds: string[] = [];
  const aggEvIds: string[] = [];

  if (deps.logs) {
    try {
      const from = logWindowFrom(input.since);
      const logQuery = { service: input.service, from, text: hint, limit: 25 };
      records = await deps.logs.searchLogs(logQuery);

      const cappedRecords = records.slice(0, 25);
      for (const r of cappedRecords) {
        const isErr = r.level === 'error' || r.level === 'fatal';
        if (isErr) errorLogCount++;
        const ev = mkEv(
          'log',
          (`[${r.level}] ${r.component ?? r.service ?? ''}: ${r.message}`).slice(0, 160),
          {
            level: r.level,
            levelValue: r.levelValue,
            component: r.component,
            eventCode: r.eventCode,
            service: r.service,
            index: r.index,
          },
          {},
          r.timestamp,
          isErr ? 0.9 : 0.5,
        );
        logEvIds.push(ev.id);
      }

      buckets = await deps.logs.aggregateErrors({ service: input.service, from });
      for (const b of buckets) {
        const ev = mkEv(
          'log',
          `${b.count}x error ${b.key}`,
          { eventCode: b.key, count: b.count, aggregate: true },
          {},
          undefined,
          Math.min(1, b.count / 100),
        );
        aggEvIds.push(ev.id);
      }
    } catch {
      // Logs failure must never break the investigation — continue without log evidence.
    }
  }

  // e. TIMELINE (deterministic; built after all evidence is accumulated)
  const timeline = buildTimeline(evidence);

  // e2. CORRELATION (deterministic grouping + cause chains + missing evidence)
  const correlation = correlate(evidence);

  // e3. HYPOTHESES (HOR-24) — deterministic competing set
  const queueNames = [...queueEvByName.keys()];
  const hyps = generateHypotheses(evidence, correlation, {
    seedLabel: label,
    queues: queueNames,
  });

  // e4. HYPOTHESIS VALIDATION (HOR-25) — adjust confidence + assign verdicts
  const validated = validateHypotheses(hyps, evidence);

  // f. FINDINGS (label kept as 'e' externally but shifted to 'f' internally)
  const findings: ReportFinding[] = [];

  // The top seed is search rank 0 — highest confidence in the resolution.
  findings.push({
    kind: 'observation',
    title: `Seed resolves to ${label} at ${top.filePath}:${seedLine}`,
    detail: top.signature ?? undefined,
    confidence: 1,
    evidenceIds: [seedEv.id],
  });

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

  // Runtime log findings (only when logs were gathered)
  if (records.length > 0) {
    findings.push({
      kind: 'observation',
      title: `Gathered ${records.length} runtime log line(s) (${errorLogCount} error-level) for ${input.service ?? 'the service'} in the window`,
      confidence: 0.6,
      evidenceIds: logEvIds,
    });
  }
  if (buckets.length > 0) {
    const topBucket = buckets[0];
    if (topBucket !== undefined) {
      findings.push({
        kind: 'anomaly',
        title: `Top runtime error: ${topBucket.count}x ${topBucket.key}`,
        confidence: 0.7,
        evidenceIds: aggEvIds,
      });
    }
  }

  // f. SUSPECTED CAUSES
  const suspectedCauses: SuspectedCause[] = [];
  const impactNorm = clamp01(impact.affected / 20);

  // Queue-path cause(s) — most specific first.
  for (const [queueName, evIds] of queueEvByName) {
    const edge = queueHits.find((e) => e.queueName === queueName);
    const producer = edge?.producerSymbol ?? 'unknown-producer';
    const worker = edge?.workerSymbol ?? 'unknown-worker';
    suspectedCauses.push({
      statement: `The ${queueName} processing path (${producer} -> ${worker}) is implicated`,
      score: clamp01(0.3 + impactNorm * 0.4),
      evidenceIds: [...evIds, impactEv.id],
    });
  }

  if (changes && changeEvId) {
    suspectedCauses.push({
      statement: `Recent change to ${top.name} in ${input.since}..HEAD may have introduced the regression`,
      score: clamp01(0.2 + impactNorm * 0.4 + (queueHits.length > 0 ? 0.1 : 0)),
      evidenceIds: [changeEvId, seedEv.id],
    });
  }

  // Always offer a blast-radius cause if the symbol has any reach.
  if (impact.affected > 0) {
    suspectedCauses.push({
      statement: `${top.name} sits on a high-fan-out path (${impact.affected} affected) and may propagate the fault`,
      score: clamp01(impactNorm * 0.5 + (queueHits.length > 0 ? 0.1 : 0)),
      evidenceIds: [impactEv.id, seedEv.id],
    });
  }

  // Runtime-errors + queue-path cause: only when we have error logs AND a queue path.
  if (errorLogCount > 0 && queueHits.length > 0) {
    const firstQueue = queueHits[0];
    const queueLabel =
      firstQueue !== undefined
        ? `"${firstQueue.queueName}" (${firstQueue.producerSymbol ?? 'unknown'} -> ${firstQueue.workerSymbol ?? 'unknown'})`
        : 'the queue path';
    suspectedCauses.push({
      statement: `Runtime error logs (${errorLogCount} error-level) correlate with the implicated queue path ${queueLabel}`,
      score: clamp01(0.3 + impactNorm * 0.3),
      evidenceIds: aggEvIds.length > 0 ? aggEvIds : logEvIds,
    });
  }

  suspectedCauses.sort((a, b) => b.score - a.score);
  const rankedCauses = suspectedCauses.slice(0, 3);

  // g. confidence
  const evidenceConfidence = clamp01(evidence.length / 8);
  const seedResolved = seeds.length > 0 ? 1 : 0;
  const confidence = clamp01(0.5 * evidenceConfidence + 0.5 * seedResolved);

  // h. summary
  const area = ctx.community?.name ?? top.filePath;
  const topCause = rankedCauses[0];
  const summary = topCause
    ? `Investigation of "${hint}" resolved to ${label} (${area}). Top suspected cause: ${topCause.statement}.`
    : `Investigation of "${hint}" resolved to ${label} (${area}). No dominant suspected cause emerged from the available structural evidence.`;

  // i. nextActions
  const nextActions = buildNextActions(top, ctx, impact, queueHits, changes, input);

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
    confidence,
    nextActions,
  };

  // HOR-19 — compute gap analysis and cap confidence BEFORE persisting so the
  // persisted record reflects the capped value.
  const gapAnalysis = detectMissingEvidence(report);
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
