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
  RedisStateProvider,
  RedisStateAnalysis,
  SentryProvider,
} from '@horus/connectors';
import { shortTs, selectStateSignals, tokenize, analyzeQueueRuntime } from '@horus/connectors';
import { formatSymbolLocation } from './render.js';
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
import { buildCauseChains } from './cause-chain.js';
import { rankCauses, type CauseInput } from './score-cause.js';
import { generateHypotheses } from './hypotheses.js';
import { validateHypotheses } from './validate.js';
import { recallSimilar, storeIncidentMemory, deriveTags } from './memory.js';
import { detectMissingEvidence, gapNextActions, type ConnectorFlags } from './gaps.js';
import { buildRuntimeSourceStatus } from './source-status.js';
import type {
  InvestigationInput,
  InvestigationReport,
  ReportFinding,
} from './types.js';
import { buildTimeline } from './timeline.js';
import { correlate } from './correlate.js';
import { rankSeeds, isTypeLikeName, executableBaseName } from './seeds.js';
import { normalizeEvidence } from './normalize.js';
import { computeWeightedEvidenceConfidence } from './confidence.js';
import { collectGitChanges } from './git-collector.js';
import type { BoundedGitChange } from './git-collector.js';

/** Dependencies the engine needs: a code provider and a database handle. */
export interface EngineDeps {
  /**
   * Source-intelligence provider. Optional (HOR-319 layer-2): when null/absent the
   * engine runs a degraded, RUNTIME-ONLY investigation — no seed resolution, no
   * structural evidence (context/impact/flows/changes/ownership), confidence capped.
   * The CLI passes null only after a down code host could not be self-healed.
   */
  code?: CodeProvider | null;
  db: HorusDb;
  /** Optional Elasticsearch logs provider — when absent the investigation runs source-intelligence-only. */
  logs?: LogsProvider | null;
  /** Optional MongoDB state provider — folds application-state anomalies as evidence. */
  mongo?: StateProvider | null;
  /** Optional Postgres state provider — same state-evidence contract as `mongo`. */
  postgres?: StateProvider | null;
  /**
   * Optional Sentry error-evidence provider — folds grouped exceptions (issues) into the
   * same error-signature / directSignatures / seed path as Elasticsearch logs. Each issue
   * carries a direct code seed (top in-app stack frame). A configured-but-empty Sentry is
   * negative evidence, not a gap; one failing provider never aborts the investigation.
   */
  sentry?: SentryProvider | null;
  /** Optional BullMQ queue runtime provider — folds queue depth/failure evidence. */
  queue?: QueueRuntimeProvider | null;
  /** Optional Redis state provider — folds cache/state/locks/rate-limit evidence (HOR-201). */
  redisState?: RedisStateProvider | null;
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

/**
 * Bind the overall-confidence CEILING to the headline suspected cause's finalScore
 * (HOR-336 extended). Overall confidence must track DIAGNOSIS strength: a weak
 * "observation" cause cannot license a high headline number just because a seed
 * localized + lots of evidence accrued.
 *
 * The mapping is MONOTONIC (higher cause score → higher allowed confidence) and is
 * applied as a Math.min ceiling by the caller — it never raises confidence:
 *   score < 0.20        → 0.60  (sub-threshold; "localized, cause unknown" — HOR-336)
 *   score in [0.20,0.50)→ 0.60 … 0.78 (a modest cause caps to the upper-mid range)
 *   score in [0.50,0.85)→ 0.78 … 1.00 (a strong cause permits high confidence)
 *   score >= 0.85       → 1.00  (no additional ceiling from the cause)
 */
export function confidenceCeilingForCause(score: number): number {
  const s = clamp01(score);
  if (s < 0.2) return 0.6;
  if (s < 0.5) {
    // [0.20,0.50) → [0.60,0.78]
    return 0.6 + ((s - 0.2) / (0.5 - 0.2)) * (0.78 - 0.6);
  }
  if (s < 0.85) {
    // [0.50,0.85) → [0.78,1.00]
    return 0.78 + ((s - 0.5) / (0.85 - 0.5)) * (1.0 - 0.78);
  }
  return 1.0;
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

export type LogRelevanceClass = 'direct' | 'ambient';

/**
 * Classify a log signature's relevance to the investigation seed (HOR-156).
 *
 * A signature is 'direct' when its key or affected services share tokens with
 * the seed name, hint, or service.  Everything else is 'ambient' — real
 * production noise, but unrelated to the thing being investigated.
 */
export function classifyLogRelevance(
  sigKey: string,
  sigServices: string[],
  seedTerms: string[],
  inputService: string | undefined,
): { relevanceClass: LogRelevanceClass; relevanceReason: string } {
  // Generic error/severity words ("error", "errors", "failing") appear in EVERY error
  // signature, so matching on them marks every unrelated error "direct" — narrating a
  // louder error from another service onto this seed/path (HOR-338). Relevance must come
  // from DOMAIN terms, not the word "error".
  const GENERIC_TERMS = new Set([
    'error', 'errors', 'err', 'fail', 'failed', 'failing', 'failure', 'exception',
    'exceptions', 'crash', 'crashing', 'issue', 'problem', 'slow', 'timeout', 'broken',
    'down', 'production', 'prod', 'staging',
  ]);
  const domainTerms = seedTerms.filter((t) => !GENERIC_TERMS.has(t));
  if (domainTerms.length === 0) {
    return { relevanceClass: 'direct', relevanceReason: 'no specific seed context — included by default' };
  }

  const keyTokens = tokenize(sigKey);
  const serviceTokens = sigServices.flatMap((s) => tokenize(s));
  const combined = [...keyTokens, ...serviceTokens];

  const matchingTerms = domainTerms.filter(
    (t) => combined.some((c) => c.includes(t) || t.includes(c)),
  );

  if (matchingTerms.length > 0) {
    return {
      relevanceClass: 'direct',
      relevanceReason: `matches seed terms: ${matchingTerms.slice(0, 3).join(', ')}`,
    };
  }

  // Service-scoped: if the log's services match the input service, treat as direct
  if (
    inputService &&
    sigServices.some((s) => s.toLowerCase().includes(inputService.toLowerCase()))
  ) {
    return {
      relevanceClass: 'direct',
      relevanceReason: `from configured service: ${inputService}`,
    };
  }

  return {
    relevanceClass: 'ambient',
    relevanceReason: 'no structural link to seed — ambient runtime noise',
  };
}

/**
 * Extract code-shaped tokens (meritt `event_code` values like HTTPFLT001 or
 * E_FULFILLMENT_SYNC_ERROR_04) from free text — the hint, a seed name, or seed
 * source. An event_code is BOTH a source raise-signature (a string literal) AND a
 * structured Elasticsearch field, so a code named by the seed/hint can be JOINED
 * to ES even when it isn't a top-N error aggregation bucket (the "no logs" vs 438
 * HTTPFLT001 errors miss). Match shape: an UPPER_SNAKE/alnum token of length ≥4
 * that contains at least one digit or underscore (so plain words like "ERROR" or
 * "FETCH" are excluded but "HTTPFLT001"/"E_SYNC_04" qualify). De-duplicated,
 * original order preserved.
 */
export function extractEventCodes(...texts: (string | undefined)[]): string[] {
  const RE = /\b(?=[A-Z0-9_]*[0-9_])[A-Z][A-Z0-9_]{3,}\b/g;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (text === undefined || text === '') continue;
    for (const m of text.matchAll(RE)) {
      const code = m[0];
      if (!seen.has(code)) {
        seen.add(code);
        out.push(code);
      }
    }
  }
  return out;
}

/**
 * Detect context field names that look like entity identifiers worth aggregating
 * (HOR-215) — brand_id, order_id, userId, etc. Used to surface "16 brands × 50
 * orders affected" instead of only an error-signature count. Returns at most
 * `limit` field names, in object order, with scalar values only.
 */
export function detectEntityFields(
  context: Record<string, unknown> | undefined,
  limit = 2,
): string[] {
  if (context === undefined) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(context)) {
    if (v === null || (typeof v !== 'string' && typeof v !== 'number')) continue;
    const looksLikeId =
      /(^|_)ids?$/i.test(k) ||
      /id$/.test(k) ||
      /^(brand|order|user|customer|account|tenant|shop|merchant|product|seller)/i.test(k);
    if (looksLikeId) {
      out.push(k);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Result of seeding an investigation from a log match instead of the hint (HOR-216). */
export interface LogReseed {
  seeds: Symbol[];
  /** Human note: what the hint matched in logs and which symbol it resolved to. */
  note: string;
  /** The component the matching log named, if any. */
  component?: string;
  /** The event_code the matching log carried, if any. */
  eventCode?: string;
}

/**
 * Fallback seed resolution for raw error-string hints (HOR-216).
 *
 * When the hint matches no source symbol, search the logs for it across message +
 * detail + context.* (broadText), then back-resolve the matching log's component to
 * a source symbol so a normal structural investigation can proceed. Returns null
 * when logs are unavailable, nothing matches, or no component resolves to a symbol.
 */
export async function reseedFromLogs(
  hint: string,
  input: InvestigationInput,
  deps: EngineDeps,
): Promise<LogReseed | null> {
  if (!deps.logs || typeof deps.logs.searchLogs !== 'function') return null;
  // Back-resolving a log component to a symbol needs source intelligence; in degraded
  // runtime-only mode (no code provider) there is nothing to reseed against.
  if (!deps.code) return null;
  const code = deps.code;
  try {
    const from = logWindowFrom(input.logsSince ?? input.since);
    const records = await deps.logs.searchLogs({
      text: hint,
      broadText: true,
      from,
      limit: 5,
      service: input.service,
    });
    if (records.length === 0) return null;

    // Components are the most likely class/file names to resolve to a symbol.
    const candidates = [...new Set(records.map((r) => r.component).filter((c): c is string => !!c))];
    for (const name of candidates) {
      const syms = await code.searchSymbols(name, 5);
      if (syms.length > 0) {
        const rankedSeeds = rankSeeds(syms, [...new Set(tokenize(name))]);
        const first = records[0];
        const componentLabel = first?.component ?? 'log entry';
        const codeLabel = first?.eventCode ? ` (${first.eventCode})` : '';
        const seedName = rankedSeeds[0]?.symbol.name ?? name;
        return {
          seeds: rankedSeeds.map((r) => r.symbol),
          note: `Hint matched no symbol; resolved via logs: ${componentLabel}${codeLabel} → ${seedName}`,
          ...(first?.component !== undefined ? { component: first.component } : {}),
          ...(first?.eventCode !== undefined ? { eventCode: first.eventCode } : {}),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
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
export function looksDiffable(since: string): boolean {
  const s = since.trim();
  if (s.length === 0) return false;
  if (s.includes('..')) return true;
  // Duration strings like "24h", "7d", "30m", "90s" are log-window specifiers,
  // not git refs — exclude them so detectChanges is not called with a non-ref.
  if (/^\d+[smhd]$/i.test(s)) return false;
  // A bare ref (tag, branch, sha) or relative ref (HEAD~5, v1.2~3) is diffable.
  return /^[A-Za-z0-9._/~^-]+$/.test(s);
}

/**
 * HOR-334: does the hint read as a behavioral "how does X work" question rather
 * than an incident report? Such hints want an explanation of a code path, not a
 * fault hunt — when there is no real incident signal, the investigation should
 * point the user at `horus explain <symbol>` instead of dumping empty incident
 * sections. Conservative: matches a how/what/why question paired with a
 * behavior/flow verb, or a leading interrogative/"explain".
 */
export function looksExplanatory(hint: string): boolean {
  const h = hint.trim();
  if (h.length === 0) return false;
  // Question/behavior pairing: "how does X work", "what happens when …", "why does … flow".
  if (/\b(how|what|why|when|where)\b.*\b(work|works|working|do|does|done|happen|happens|flow|flows|behave|called|invoked|triggered|used)\b/i.test(h)) {
    return true;
  }
  // Leading interrogative or an explicit "explain"/"describe"/"walk me through".
  if (/^\s*(how|what|why|when|where|explain|describe|walk\s+me\s+through|tell\s+me\s+(?:about|how))\b/i.test(h)) {
    return true;
  }
  return false;
}

/**
 * HOR-333: build the commit + changed-symbol citation clauses for the regression
 * cause title. Cites the most-recent 1-2 commits (short SHA + subject) from the
 * bounded git history and the changed symbol name(s) from the source-backend
 * ChangeSet. Bounded so the headline stays scannable. Returns empty clauses when
 * no commits/symbols are available, so the title degrades to the prior wording.
 */
export function formatRegressionCitation(
  recentChanges: BoundedGitChange | undefined,
  changes: ChangeSet | null,
  seedFile?: string,
): { commitClause: string; symbolClause: string } {
  const matchesSeed = (f: string): boolean =>
    seedFile === undefined || f === seedFile || seedFile.endsWith(f) || f.endsWith(seedFile);

  // #3 (dogfood): attribute to the commit(s) that ACTUALLY touched the seed's file — NOT the two
  // newest commits in the --since window. The old behaviour blamed unrelated recent commits and
  // tripped the off-by-one release-tag trap (the touching commit is an ancestor of the tag). When
  // no in-window commit touched the seed, cite nothing — the caller frames that honestly rather
  // than fabricating a culprit.
  const all = recentChanges?.commits ?? [];
  const seedCommits = seedFile ? all.filter((c) => c.files.some(matchesSeed)) : all;
  const commits = seedCommits.slice(0, 2);
  const commitParts = commits.map((c) => {
    const sha = c.shortSha || c.sha.slice(0, 7);
    const subject = (c.subject ?? '').replace(/\s+/g, ' ').trim();
    return subject ? `${sha} "${subject.slice(0, 50)}"` : sha;
  });
  const commitClause = commitParts.length > 0 ? ` (${commitParts.join(', ')})` : '';

  // Changed symbol names — restricted to the seed's file so cross-service symbols from the same
  // window aren't narrated onto this seed (prefer the post-change name).
  const modified = (changes?.modified ?? []).filter((m) =>
    matchesSeed(((m.after ?? m.before) as { filePath?: string }).filePath ?? ''),
  );
  const symbolNames: string[] = [];
  for (const m of modified) {
    const name = m.after?.name ?? m.before?.name;
    if (name && !symbolNames.includes(name)) symbolNames.push(name);
    if (symbolNames.length >= 3) break;
  }
  let symbolClause = '';
  if (symbolNames.length > 0) {
    const shown = symbolNames.join(', ');
    const more = modified.length > symbolNames.length ? ', …' : '';
    symbolClause = ` touched ${shown}${more}`;
  }

  return { commitClause, symbolClause };
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
  // Pass hint tokens so domain-specific symbols (e.g. ShopifyWebhookController)
  // beat generic architectural matches (e.g. BrandService) when the hint names
  // the domain explicitly.
  // HOR-319 layer-2: with no source-intelligence provider the engine runs RUNTIME-ONLY.
  // Skip seed resolution entirely — there are no symbols to resolve against.
  const degradedNoSource = !code;
  // HOR-94 / HOR-193 — bounded git change summary for the incident window. Computed FIRST
  // (independent of source intelligence) so commit evidence works in degraded runtime-only
  // mode, when the source-backend ChangeSet is unavailable, or when --since is a relative
  // ref (HEAD~5) detectChanges can't take — AND so a --since regression investigation can
  // steer the seed toward changed code: the culprit lives in the diff, not an unrelated
  // unchanged function (HOR-328 round-3).
  let recentChanges: BoundedGitChange | undefined;
  if (deps.repoPath && input.since) {
    try {
      recentChanges = await collectGitChanges({ repoPath: deps.repoPath, since: input.since });
    } catch {
      // Best-effort; skip on error
    }
  }
  const changedFilePaths =
    recentChanges && recentChanges.changedFiles.length > 0
      ? new Set(recentChanges.changedFiles)
      : undefined;
  const rawSeeds = code ? await code.searchSymbols(hint, 5) : [];
  const hintTokens = [...new Set(tokenize(hint))];
  const ranked = rankSeeds(rawSeeds, hintTokens, changedFilePaths);
  let seeds = ranked.map((r) => r.symbol);
  // noUncheckedIndexedAccess: a non-empty array could still index to undefined.
  let top: Symbol | undefined = seeds[0];

  // HOR-337: if the best seed is a TYPE/DTO declaration (e.g. `SyncBrandFulfillmentsResult`),
  // the fault lives in the same-named EXECUTABLE, not the type. Search often only returns
  // the type (its name hugs the hint), so demotion alone can't help — derive the base name
  // and re-search for a method/function counterpart, preferring it when one is found.
  if (top && code && isTypeLikeName(top.name)) {
    const base = executableBaseName(top.name);
    if (base) {
      const altTop = rankSeeds(await code.searchSymbols(base, 5), hintTokens).find(
        (r) => !isTypeLikeName(r.symbol.name),
      )?.symbol;
      if (altTop && altTop.id !== top.id) {
        seeds = [altTop, ...seeds.filter((s) => s.id !== altTop.id)];
        top = altTop;
      }
    }
  }

  // HOR-216: a raw error string (e.g. "getaddrinfo ENOTFOUND host") matches no
  // source symbol. Before giving up, search the logs for the hint (across message,
  // detail, and context.*), then back-resolve the matching log's component to a
  // source symbol and seed the investigation from there. Best-effort.
  let logReseed: LogReseed | null = null;
  if (!top && !degradedNoSource) {
    logReseed = await reseedFromLogs(hint, input, deps);
    if (logReseed !== null) {
      seeds = logReseed.seeds;
      top = seeds[0];
    }
  }

  // HOR-335: a seed with ZERO hint-token overlap (and not log-reseeded) is a
  // semantic/fuzzy guess — not a match to anything the hint actually named. Flag it
  // so we disclose the low confidence and damp the headline, else investigate
  // fabricates a confident result for input that matches no real symbol (e.g.
  // "ZzzNonexistentService is throwing" silently resolved to the helper `err`).
  const seedHay = top ? `${top.name} ${top.filePath}`.toLowerCase() : '';
  // Generic architectural/severity words match almost any file path ("service" is in
  // every *.service.ts) — they don't indicate the seed is what the hint actually named.
  const GENERIC_HINT_TOKENS = new Set([
    'service', 'services', 'controller', 'controllers', 'resolver', 'resolvers', 'worker',
    'workers', 'repository', 'provider', 'module', 'manager', 'util', 'utils', 'helper',
    'handler', 'error', 'errors', 'exception', 'exceptions', 'fail', 'failed', 'failing',
    'failure', 'throw', 'throwing', 'thrown', 'fatal', 'crash', 'crashing', 'timeout',
    'production', 'prod', 'staging', 'application', 'issue', 'problem', 'broken', 'slow',
  ]);
  const meaningfulHintTokens = hintTokens.filter((t) => !GENERIC_HINT_TOKENS.has(t));
  const seedIsLowConfidence =
    top !== undefined &&
    logReseed === null &&
    meaningfulHintTokens.length > 0 &&
    !meaningfulHintTokens.some((t) => seedHay.includes(t));

  // Empty-result only when source intelligence WAS available but resolved nothing.
  // In degraded runtime-only mode we fall through and build a report from runtime
  // evidence instead (HOR-319 layer-2).
  if (!top && !degradedNoSource) {
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
        deps.logs != null
          ? `No symbols matched "${hint}", and no recent error log matched it either. Try a more specific hint — an exact function, class, or file name — or widen --since.`
          : `No symbols matched "${hint}". Try a more specific hint — an exact function, class, or file name.`,
      ],
    };
    const persistedId = await persist(db, input, report);
    if (persistedId) report.id = persistedId;
    return report;
  }

  // (recentChanges — the bounded git change summary — is computed up front, before seed
  // resolution above, so a --since regression investigation can steer the seed toward
  // changed code.)

  // Structural-evidence accumulators. Populated only when a seed resolved (full run);
  // they stay at these runtime-only defaults in degraded mode (HOR-319 layer-2), where
  // the report is built from runtime evidence (logs/metrics/state/queues) alone.
  let label = input.service ?? hint;
  let seedLoc = '';
  let ctx: SymbolContext | null = null;
  let impact: ImpactResult | null = null;
  let flows: Awaited<ReturnType<CodeProvider['flowsFor']>> = [];
  let seedEv: Evidence | null = null;
  let impactEv: Evidence | null = null;
  const flowEvIds: string[] = [];
  let queueHits: QueueEdge[] = [];
  const queueEvByName = new Map<string, string[]>();
  let changes: ChangeSet | null = null;
  let changeEvId: string | null = null;

  if (top && code) {
    // A "constructor" seed is really its class — surface a friendlier label in the report.
    label =
      top.name === 'constructor'
        ? `${(top.id.split(':').pop() ?? '').replace(/\.constructor$/, '') || top.name} (constructor)`
        : top.name;

    // c. GATHER
    [ctx, impact, flows] = await Promise.all([
      code.context(top.id),
      code.impact(top.id, 2),
      code.flowsFor(top.id),
    ]);
    let edges: QueueEdge[] = [];
    try {
      edges = await listQueueEdges(db, { project: input.repo });
    } catch {
      // Investigation-store DB unreachable — degrade (HOR-319 spirit) rather than
      // aborting the whole investigation: skip queue-edge evidence. persist() already
      // tolerates a down DB, so the report still runs, renders, and reports telemetry.
      edges = [];
    }

    const symbolNames = new Set<string>([
      top.name,
      ...ctx.callers.map((s) => s.name),
      ...ctx.callees.map((s) => s.name),
    ]);
    queueHits = edges.filter((e) => {
      const bySymbol =
        (e.producerSymbol !== null && symbolNames.has(e.producerSymbol)) ||
        (e.workerSymbol !== null && symbolNames.has(e.workerSymbol));
      const byFile =
        e.producerFile === top.filePath || e.workerFile === top.filePath;
      return bySymbol || byFile;
    });

    if (input.since !== undefined && looksDiffable(input.since)) {
      try {
        changes = await code.detectChanges({ base: input.since, compare: 'HEAD' });
      } catch {
        changes = null;
      }
    }

    // d. BUILD Evidence
    seedLoc = formatSymbolLocation(top.filePath, top.startLine, top.endLine);
    seedEv = mkEv(
      'symbol',
      `Seed symbol ${top.name} (${seedLoc})`,
      { symbol: top, snippet: ctx.snippet ?? null },
      top.startLine !== undefined && top.startLine > 0
        ? { symbolId: top.id, file: top.filePath, line: top.startLine }
        : { symbolId: top.id, file: top.filePath },
    );

    for (const flow of flows) {
      const ev = mkEv(
        'flow',
        `Flow "${flow.name}" (${flow.steps.length} step(s))`,
        { flowId: flow.id, name: flow.name, steps: flow.steps.map((s) => s.name) },
        { symbolId: top.id, file: top.filePath },
      );
      flowEvIds.push(ev.id);
    }

    impactEv = mkEv(
      'impact',
      `Impact of ${top.name}: ${impact.affected} affected symbol(s)`,
      { affected: impact.affected },
      { symbolId: top.id, file: top.filePath },
    );

    // One queue-edge evidence per hit; track ids per distinct queue for findings/causes.
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
  }

  // HOR-193: when the source-backend ChangeSet is unavailable but git history was
  // collected (e.g. --since HEAD~5, source backend down, or degraded runtime-only mode),
  // synthesize a commit evidence entry so hypotheses + gaps receive the change signal.
  if (changes === null && recentChanges !== undefined && recentChanges.commits.length > 0) {
    const { commits, changedFiles, totalInsertions, totalDeletions } = recentChanges;
    const ev = mkEv(
      'commit',
      `Git history ${input.since}..HEAD: ${commits.length} commit(s), ${changedFiles.length} file(s) changed (+${totalInsertions} -${totalDeletions})`,
      { commits: commits.slice(0, 10), changedFiles: changedFiles.slice(0, 30), totalInsertions, totalDeletions, source: 'git' },
      {},
    );
    changeEvId = ev.id;
  }

  // e0. RUNTIME LOG EVIDENCE (HOR-10/13) — synthesize error SIGNATURES, not raw log
  // dumps. Optional; never breaks the investigation on failure.
  let analysis: LogAnalysis | null = null;
  const logEvIds: string[] = [];
  const directLogEvIds: string[] = [];
  const ambientLogEvIds: string[] = [];
  // HOR-338: track the DIRECT signatures (not just their evidence ids) so the
  // error-correlation cause cites the errors actually linked to the seed/path — not
  // the global top error, which co-occurrence would otherwise cross-wire onto an
  // unrelated path (e.g. a scheduler error narrated onto a webhook worker).
  const directSignatures: { key: string; count: number; message: string }[] = [];
  // HOR-341: signature key → its DIRECT log evidence id, so a seed-emitted code that
  // is ALSO a top signature (deduped by the join) can still be linked to its existing
  // evidence when promoted to a headline cause.
  const directEvIdByKey = new Map<string, string>();
  // HOR-341: a runtime error EMITTED FROM THE SEED FUNCTION (its literal appears in the
  // seed's own source body) that also has live Elasticsearch occurrences is the strongest
  // possible link — the seed RAISES this recurring error. Track those joined codes (with
  // the evidence id that backs them) so a dedicated headline cause can be formed and the
  // "#1/#2 no cause structurally linked" reframing yields to them. Hint-only codes are NOT
  // recorded here — they stay direct evidence but are not promoted to a cause.
  const seedEmittedJoins: {
    code: string;
    count: number;
    message: string;
    evId: string;
    isNew: boolean;
  }[] = [];
  // HOR-215: distinct-failing-entity evidence (e.g. "16 brand_id, 50 order_id").
  const entityEvIds: string[] = [];
  const entitySummaries: string[] = [];
  let logsCollected = false;
  let logsCompatibilityError: string | undefined;

  if (deps.logs) {
    try {
      // Validate field mapping against the actual index before querying so an
      // incompatible config surfaces as an honest gap rather than empty evidence.
      // Pass requiresService so a missing service field is an error, not a warning.
      const compat = await deps.logs.checkCompatibility({
        requiresService: input.service !== undefined,
        requiresServiceAggregation: true,
        requiresEventCode: true,
      });
      const compatErrors = compat.issues.filter((i) => i.severity === 'error');
      if (compatErrors.length > 0) {
        logsCompatibilityError = compatErrors
          .map((i) => `${i.field}: ${i.message}`)
          .join('; ')
          .slice(0, 300);
      } else {
        const logsSince = input.logsSince ?? input.since;
        const from = logWindowFrom(logsSince);
        // Error signatures are scoped by service + window, NOT by the hint text:
        // the errors that matter to an incident rarely contain the hint words in
        // their message (the hint resolves the code seed; the service scopes logs).
        analysis = await deps.logs.analyzeErrors({ service: input.service, from });
        // Auto-widen: the 7-day default frequently misses a real incident only slightly older
        // — a common false "no error logs matched". When nothing matched and no window was
        // pinned (--logs-since / a duration --since), retry once at 30d and keep it only if it
        // actually surfaces signatures.
        if (analysis.signatures.length === 0 && logsSince === undefined) {
          const retry = await deps.logs.analyzeErrors({
            service: input.service,
            from: logWindowFrom('30d'),
          });
          if (retry.signatures.length > 0) analysis = retry;
        }
        logsCollected = true;

        // Seed relevance terms: used to classify each signature as 'direct' or
        // 'ambient' so unrelated high-volume errors don't dominate (HOR-156). In
        // degraded runtime-only mode there is no seed symbol, so terms come from the
        // hint alone (classifyLogRelevance handles an empty seed-term set).
        const seedBase = top ? top.filePath.split('/').pop() ?? '' : '';
        const logSeedTerms = top
          ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(seedBase)])]
          : [...new Set(tokenize(hint))];

        for (const s of analysis.signatures.slice(0, 15)) {
          const { relevanceClass, relevanceReason } = classifyLogRelevance(
            s.key,
            s.services,
            logSeedTerms,
            input.service,
          );

          const tags: string[] = [];
          if (relevanceClass === 'ambient') tags.push('ambient');
          if (s.isNew) tags.push('NEW');
          else if (s.ratio !== undefined && Number.isFinite(s.ratio) && s.ratio >= 1.5) {
            tags.push(`spike x${s.ratio.toFixed(1)}`);
          }
          const svc = s.services.length > 0 ? ` · ${s.services.slice(0, 3).join(', ')}` : '';
          const tagStr = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
          // HOR-330: surface a representative message so the error means something beyond a
          // bare count — e.g. "Error checking brand order fulfillment" points straight at the
          // (data) cause that the signature key + count alone never reveal.
          const msgStr = s.sampleMessage
            ? ` — "${s.sampleMessage.replace(/\s+/g, ' ').trim().slice(0, 90)}"`
            : '';
          const ev = mkEv(
            'log',
            `Error ${s.key}: ${s.count}x (first ${shortTs(s.firstSeen)}, last ${shortTs(s.lastSeen)})${svc}${tagStr}${msgStr}`.slice(
              0,
              220,
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
              relevanceClass,
              relevanceReason,
            },
            {},
            s.lastSeen || undefined,
            // Direct evidence: full recurrence weight. Ambient: demoted baseline.
            // This prevents unrelated high-volume errors from inflating confidence.
            relevanceClass === 'direct'
              ? s.isNew
                ? 0.95
                : s.ratio !== undefined && s.ratio >= 1.5
                  ? 0.90
                  : 0.85
              : s.isNew
                ? 0.70
                : s.ratio !== undefined && s.ratio >= 1.5
                  ? 0.55
                  : 0.35,
          );
          // Normalize recurrence signals to top-level Evidence fields so the
          // Cause Scoring Engine can read them without inspecting the payload.
          if (s.isNew) ev.isNew = s.isNew;
          if (typeof s.ratio === 'number' && Number.isFinite(s.ratio)) ev.ratio = s.ratio;
          logEvIds.push(ev.id);
          if (relevanceClass === 'direct') {
            directLogEvIds.push(ev.id);
            directSignatures.push({ key: s.key, count: s.count, message: s.sampleMessage ?? '' });
            if (!directEvIdByKey.has(s.key)) directEvIdByKey.set(s.key, ev.id);
          } else ambientLogEvIds.push(ev.id);
        }

        // CROSS-SIGNAL event_code JOIN — meritt's `event_code` is BOTH a source
        // raise-signature (a string literal in code) AND a structured Elasticsearch
        // field. analyzeErrors above only aggregates the top-N signatures, so a
        // SPECIFIC code the seed/hint cares about — but that isn't a top bucket — is
        // missed (the real "no logs" while ES held 438 HTTPFLT001 errors). Here we
        // pull the exact codes named by the source signal (hint + seed name + seed
        // source snippet) and query ES for each by its keyword field. A code that
        // returns count > 0 is an EXACT structured match to the source signal — the
        // strongest possible runtime link — so it becomes DIRECT, seed-linked
        // evidence. Best-effort: a logs failure never breaks the investigation.
        // Prefer the FULL seed body (sourceBody) over the bounded display snippet: a
        // runtime error RAISED FROM the seed has its code literal anywhere in the body,
        // often near the end — past the snippet cutoff (the maison
        // `E_FULFILLMENT_SYNC_ERROR_04` at order.service.ts:613 lives ~110 lines into the
        // function). Fall back to snippet when no full body is available.
        const seedSnippet =
          (ctx?.sourceBody !== undefined && ctx.sourceBody !== null
            ? ctx.sourceBody
            : undefined) ??
          (ctx?.snippet !== undefined && ctx.snippet !== null ? ctx.snippet : undefined);
        const sourceCodes = extractEventCodes(input.hint, top?.name, seedSnippet);
        // HOR-341: codes whose LITERAL appears in the seed's own source body are
        // seed-EMITTED — the seed RAISES them. A seed-emitted code with live ES
        // occurrences is the strongest possible link (not just a co-occurring code the
        // hint mentioned), so it is promoted to a dedicated headline cause below.
        const seedEmittedCodes = new Set(
          seedSnippet !== undefined ? extractEventCodes(seedSnippet) : [],
        );
        const joinedCodes = new Set(directSignatures.map((d) => d.key));
        for (const code of sourceCodes) {
          const alreadyJoined = joinedCodes.has(code);
          joinedCodes.add(code);
          try {
            const codeAnalysis = await deps.logs.analyzeErrors({
              service: input.service,
              from,
              eventCode: code,
            });
            const sig = codeAnalysis.signatures.find((s) => s.key === code);
            if (sig === undefined || sig.count <= 0) continue;

            // Dedup: a code already surfaced as a top signature is not re-added as
            // evidence — but if it is SEED-EMITTED it must still be promoted to a cause.
            // Reuse its existing direct evidence id when one exists.
            if (alreadyJoined) {
              if (seedEmittedCodes.has(code)) {
                const existingEvId = directEvIdByKey.get(code);
                if (existingEvId !== undefined) {
                  seedEmittedJoins.push({
                    code,
                    count: sig.count,
                    message: sig.sampleMessage ?? '',
                    evId: existingEvId,
                    isNew: sig.isNew ?? false,
                  });
                }
              }
              continue;
            }

            const links: EvidenceLinks =
              top !== undefined
                ? top.startLine !== undefined && top.startLine > 0
                  ? { symbolId: top.id, file: top.filePath, line: top.startLine }
                  : { symbolId: top.id, file: top.filePath }
                : {};
            const ev = mkEv(
              'log',
              `event_code ${code}: ${sig.count}x in Elasticsearch (exact structured match to the source signal)`.slice(
                0,
                220,
              ),
              {
                signature: code,
                count: sig.count,
                firstSeen: sig.firstSeen,
                lastSeen: sig.lastSeen,
                services: sig.services,
                isNew: sig.isNew ?? false,
                ratio: sig.ratio ?? null,
                sampleMessage: sig.sampleMessage ?? null,
                relevanceClass: 'direct',
                relevanceReason: `exact event_code match to the source signal (${code})`,
                crossSignalJoin: true,
                seedEmitted: seedEmittedCodes.has(code),
              },
              links,
              sig.lastSeen || undefined,
              0.9,
            );
            if (sig.isNew) ev.isNew = sig.isNew;
            if (typeof sig.ratio === 'number' && Number.isFinite(sig.ratio)) ev.ratio = sig.ratio;
            logEvIds.push(ev.id);
            directLogEvIds.push(ev.id);
            directSignatures.push({
              key: code,
              count: sig.count,
              message: sig.sampleMessage ?? '',
            });
            if (!directEvIdByKey.has(code)) directEvIdByKey.set(code, ev.id);
            if (seedEmittedCodes.has(code)) {
              seedEmittedJoins.push({
                code,
                count: sig.count,
                message: sig.sampleMessage ?? '',
                evId: ev.id,
                isNew: sig.isNew ?? false,
              });
            }
          } catch {
            // best-effort per-code; a logs failure must never break the investigation
          }
        }

        // HOR-215: surface the DISTINCT failing entities behind the dominant error
        // signature (e.g. "16 brands × 50 orders") instead of only a signature count.
        // Pick the top signature that carries id-like context fields and aggregate
        // each, scoped to that signature. Best-effort — never breaks the investigation.
        if (typeof deps.logs.aggregateErrors === 'function') {
          const sigForEntities = analysis.signatures.find(
            (s) => detectEntityFields(s.sampleContext).length > 0,
          );
          if (sigForEntities !== undefined) {
            for (const f of detectEntityFields(sigForEntities.sampleContext)) {
              try {
                const buckets = await deps.logs.aggregateErrors(
                  {
                    service: input.service,
                    from,
                    eventCode:
                      sigForEntities.key !== '(none)' ? sigForEntities.key : undefined,
                  },
                  `context.${f}`,
                );
                if (buckets.length > 0) {
                  const top3 = buckets
                    .slice(0, 3)
                    .map((b) => `${b.key} (${b.count}x)`)
                    .join(', ');
                  // aggregateErrors caps at 20 buckets — show "N+" when saturated.
                  const plus = buckets.length >= 20 ? '+' : '';
                  const ev = mkEv(
                    'log',
                    `Distinct context.${f} for ${sigForEntities.key}: ${buckets.length}${plus} value(s) (top: ${top3})`.slice(
                      0,
                      180,
                    ),
                    {
                      field: `context.${f}`,
                      signature: sigForEntities.key,
                      distinctShown: buckets.length,
                      capped: buckets.length >= 20,
                      top: buckets.slice(0, 10),
                    },
                    {},
                    undefined,
                    0.6,
                  );
                  entityEvIds.push(ev.id);
                  entitySummaries.push(`${buckets.length}${plus} ${f}`);
                }
              } catch {
                // best-effort per-field; skip on error
              }
            }
          }
        }
      }
    } catch {
      // Logs failure must never break the investigation — continue without log evidence.
      analysis = null;
    }
  }

  // e0a2. SENTRY ERROR EVIDENCE (HOR-CONNECTORS) — grouped exceptions (issues) folded
  // into the SAME error-signature / directSignatures / seed path as Elasticsearch logs.
  // Each issue is both "what's the error" (title + culprit + count + frequency) AND a
  // direct code seed (its latest event's top in-app stack frame → filePath:fn:line).
  // Optional; a configured-but-empty Sentry is negative evidence (not a gap). One failing
  // provider must never abort the investigation.
  let sentryCollected = false;
  let sentryIssueCount = 0;
  if (deps.sentry) {
    try {
      const from = logWindowFrom(input.logsSince ?? input.since);
      const to = new Date().toISOString();
      // Seed terms mirror the log block: hint + seed symbol + seed file base, so a Sentry
      // frame that points at the implicated code is classified 'direct' (HOR-156).
      const sentrySeedBase = top ? top.filePath.split('/').pop() ?? '' : '';
      const sentryTerms = top
        ? [...new Set([...tokenize(hint), ...tokenize(top.name), ...tokenize(sentrySeedBase)])]
        : [...new Set(tokenize(hint))];
      const seedFileBase = top ? (top.filePath.split('/').pop() ?? '').toLowerCase() : '';

      const signatures = await deps.sentry.collect({ from, to, hintTerms: sentryTerms });
      sentryCollected = true;
      sentryIssueCount = signatures.length;

      for (const sig of signatures.slice(0, 15)) {
        const { issue, frame } = sig;
        // A signature "key" the relevance classifier can tokenize: the issue title plus
        // culprit + frame symbol/file (so domain terms in any of them count).
        const sigKey = [issue.title, issue.culprit ?? '', frame?.function ?? '', frame?.filename ?? '']
          .filter(Boolean)
          .join(' ');
        // The frame's file is the strongest link: when it matches the resolved seed file,
        // this issue IS the error at the seed — force 'direct'.
        const frameFileBase = (frame?.filename ?? '').split('/').pop()?.toLowerCase() ?? '';
        const frameMatchesSeed =
          seedFileBase.length > 0 && frameFileBase.length > 0 &&
          (frameFileBase === seedFileBase || frameFileBase.includes(seedFileBase) || seedFileBase.includes(frameFileBase));

        const { relevanceClass: classified, relevanceReason } = classifyLogRelevance(
          sigKey,
          frame?.filename ? [frame.filename] : [],
          sentryTerms,
          input.service,
        );
        const relevanceClass: LogRelevanceClass = frameMatchesSeed ? 'direct' : classified;
        const reason = frameMatchesSeed
          ? `Sentry frame at seed file ${frame?.filename ?? ''}`
          : relevanceReason;

        const frameLoc = frame?.filename
          ? ` @ ${frame.filename}${frame.lineno !== undefined ? `:${frame.lineno}` : ''}`
          : '';
        const culprit = issue.culprit ? ` · ${issue.culprit}` : '';
        const tag = relevanceClass === 'ambient' ? ' [ambient]' : '';
        const title =
          `Sentry ${issue.title}: ${issue.count}x${issue.userCount > 0 ? ` · ${issue.userCount} user(s)` : ''} (last ${shortTs(issue.lastSeen ?? '')})${culprit}${frameLoc}${tag}`.slice(
            0,
            220,
          );

        const links: EvidenceLinks = {};
        if (frame?.filename !== undefined) links.file = frame.filename;
        if (frame?.lineno !== undefined) links.line = frame.lineno;

        const ev = mkEv(
          'log',
          title,
          {
            source: 'sentry',
            issueId: issue.id,
            signature: issue.title,
            count: issue.count,
            userCount: issue.userCount,
            culprit: issue.culprit ?? null,
            level: issue.level ?? null,
            lastSeen: issue.lastSeen ?? null,
            firstSeen: issue.firstSeen ?? null,
            permalink: issue.permalink ?? null,
            // Direct code seed — same fields the engine reads off a code symbol.
            filePath: frame?.filename ?? null,
            symbolName: frame?.function ?? null,
            lineStart: frame?.lineno ?? null,
            relevanceClass,
            relevanceReason: reason,
          },
          links,
          issue.lastSeen || undefined,
          // Direct: full error weight, boosted when the raise-site frame is resolved.
          // Ambient: demoted so unrelated high-volume groups don't inflate confidence.
          relevanceClass === 'direct'
            ? frame?.filename
              ? 0.95
              : 0.85
            : 0.4,
        );
        logEvIds.push(ev.id);
        if (relevanceClass === 'direct') {
          directLogEvIds.push(ev.id);
          directSignatures.push({ key: issue.title, count: issue.count, message: issue.title });
        } else {
          ambientLogEvIds.push(ev.id);
        }
      }
    } catch {
      // Sentry failure must never break the investigation — continue without it.
      sentryCollected = false;
    }
  }

  // e0b. MONGODB STATE (HOR-33) — application-state anomalies as evidence. Optional;
  // never breaks the investigation on failure. Counts/state only — no raw documents.
  let stateAnalysis: StateAnalysis | null = null;
  const stateEvIds: string[] = [];
  const stateCollections = new Set<string>();
  // HOR-332: anomaly state signals (records stuck in a failed/stale state) are a data
  // CAUSE class, not just a finding — many prod incidents are data, not code.
  const dataAnomalyEvIds: string[] = [];
  const dataAnomalyCollections: string[] = [];

  // Any configured state provider (Mongo and/or Postgres) contributes the same
  // state-evidence shape; one provider failing must not abort the others.
  const stateProviders = [deps.mongo, deps.postgres].filter(
    (p): p is StateProvider => p != null,
  );
  for (const provider of stateProviders) {
    try {
      const analysis = await provider.analyzeState();
      stateAnalysis = analysis;
      // Relevance terms: hint tokens only. Using seed name/file tokens (e.g. "service"
      // from BrandService) causes generic architectural words to match unrelated
      // collections (e.g. "services", "handlers"). Domain context lives in the hint.
      const stateTerms = [...new Set(tokenize(hint))];
      for (const s of selectStateSignals(analysis, stateTerms)) {
        const ev = mkEv('state', s.title, s.payload, {}, s.timestamp, s.relevance);
        stateEvIds.push(ev.id);
        stateCollections.add(s.collection);
        if (s.kind === 'anomaly') {
          dataAnomalyEvIds.push(ev.id);
          dataAnomalyCollections.push(s.collection);
        }
      }
    } catch {
      // Leave any prior provider's analysis intact.
    }
  }

  // e0b2. REDIS RUNTIME STATE (HOR-201) — cache/state/locks/rate-limit summaries as
  // evidence. Optional; never breaks the investigation on failure. Counts/prefixes
  // only — no key values.
  let redisStateAnalysis: RedisStateAnalysis | null = null;
  const redisStateEvIds: string[] = [];
  if (deps.redisState) {
    try {
      redisStateAnalysis = await deps.redisState.analyzeRedisState();
      const redisTerms = [...new Set(tokenize(hint))];
      for (const s of redisStateAnalysis.signals) {
        // Boost relevance when a hint term appears in the signal's match text.
        const matched = redisTerms.some((t) => t.length > 2 && s.matchText.includes(t));
        const relevance = matched ? Math.min(1, s.relevance + 0.3) : s.relevance;
        const ev = mkEv('redis-key', s.title, s.payload, {}, redisStateAnalysis.collectedAt, relevance);
        redisStateEvIds.push(ev.id);
      }
    } catch {
      redisStateAnalysis = null;
    }
  }

  // e0c. QUEUE RUNTIME STATE (HOR-12) — backlog, failures, starvation as evidence.
  // Scoped to the queues that appear in the stitcher edges so we only query what's
  // relevant to this investigation. Optional; never breaks on failure.
  let queueRuntimeState: QueueRuntimeState | null = null;
  const queueRuntimeEvIds: string[] = [];
  // Per-queue evidence IDs — three views: all, backlog-only, starvation-only.
  // Keeping them separate prevents cross-queue evidence contamination in hypotheses.
  const queueRuntimeEvIdsByQueue = new Map<string, string[]>();
  const queueBacklogEvIdsByQueue = new Map<string, string[]>();
  const queueStarvationEvIdsByQueue = new Map<string, string[]>();
  // HOR-328 round-2: dominant queue failed-job reasons (e.g. "getaddrinfo ENOTFOUND"),
  // captured so a network/dependency failure that only surfaces in queue forensics — not
  // the live error-log stream — can still be promoted to a cause (the GAIA DNS case).
  const queueFailureSignals: {
    reason: string;
    queueName: string;
    evId: string;
    count: number;
    stale: boolean;
  }[] = [];

  if (deps.queue) {
    try {
      // Probe the UNION of statically-known queues (from stitcher edges) and queues
      // discovered live in Redis (HOR-205) — the same union `horus queues --live`
      // uses. Static-only probing (queueHits) skipped live queue evidence entirely
      // whenever the hint matched no static queue edge, and hid runtime-only queues
      // (present in BullMQ with no static producer/worker mapping, e.g. a failing
      // sync job) even when a queue was hit. Discovery is best-effort: a failure
      // falls back to the static names so a flaky scan never drops known queues.
      const staticNames = [...new Set(queueHits.map((e) => e.queueName))];
      const discovered = await deps.queue.discoverQueues().catch(() => [] as string[]);
      const queueNames = [...new Set([...staticNames, ...discovered])];
      if (queueNames.length > 0) {
        queueRuntimeState = await deps.queue.analyzeQueues({ queueNames });
      }
      for (const s of analyzeQueueRuntime(queueRuntimeState ?? { prefix: '', collectedAt: '', queues: [] })) {
        const ev = mkEv('queue-state', s.title, s.payload, { queueName: s.queueName }, s.timestamp, s.relevance);
        queueRuntimeEvIds.push(ev.id);
        const perQueue = queueRuntimeEvIdsByQueue.get(s.queueName) ?? [];
        perQueue.push(ev.id);
        queueRuntimeEvIdsByQueue.set(s.queueName, perQueue);
        if (s.kind === 'backlog') {
          const bl = queueBacklogEvIdsByQueue.get(s.queueName) ?? [];
          bl.push(ev.id);
          queueBacklogEvIdsByQueue.set(s.queueName, bl);
        } else if (s.kind === 'worker-starvation') {
          const st = queueStarvationEvIdsByQueue.get(s.queueName) ?? [];
          st.push(ev.id);
          queueStarvationEvIdsByQueue.set(s.queueName, st);
        }
        if (s.kind === 'failed-breakdown') {
          const p = s.payload as { topReason?: unknown; topCount?: unknown; topStale?: unknown };
          if (typeof p.topReason === 'string') {
            queueFailureSignals.push({
              reason: p.topReason,
              queueName: s.queueName,
              evId: ev.id,
              count: typeof p.topCount === 'number' ? p.topCount : 0,
              stale: p.topStale === true,
            });
          }
        }
      }
    } catch {
      queueRuntimeState = null;
    }
  }

  // e0d. METRIC EVIDENCE (HOR-11 / HOR-40) — Grafana anomaly findings scoped by hint.
  // Optional; never breaks the investigation on failure.
  // Timeout is generous (30 s) because dashboard discovery + dual-window queries
  // per panel can easily exceed 10 s on a real Grafana instance. `horus metrics`
  // has no timeout, so we match its effective behaviour here.
  const METRICS_TIMEOUT_MS = 30_000;
  const metricEvIds: string[] = [];
  const latencyMetricEvIds: string[] = [];
  const queueMetricEvIds: string[] = [];
  // Per-queue metric IDs — queue-growth anomalies attributed to the matching queue name.
  const queueMetricEvIdsByQueue = new Map<string, string[]>();
  // Neutral/contradicting metric evidence: metrics WERE checked but found no anomaly.
  // Recorded so replay/postmortem show metrics were inspected (and weaken metric-driven
  // causes) rather than the result staying external to the investigation (HOR-203).
  const nominalMetricEvIds: string[] = [];
  let metricsCollected = false;
  let metricsFailureReason: string | undefined;
  let metricSeriesChecked = 0;

  if (deps.metrics) {
    const ac = new AbortController();
    let metricsTimerId: ReturnType<typeof setTimeout> | undefined;
    try {
      const fromMs = new Date(logWindowFrom(input.logsSince ?? input.since)).getTime();
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
      // Canonical-to-normalized map: match using normalized form, store under original case.
      // A queue named 'OrderSync' lowercases to 'ordersync', which is what appears in
      // panel titles. Storing by canonical name ensures hypothesis lookup succeeds.
      const queueNormToCanonical = new Map<string, string>();
      for (const edge of queueHits) {
        const norm = edge.queueName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (!queueNormToCanonical.has(norm)) queueNormToCanonical.set(norm, edge.queueName);
      }
      const serviceFilter = (input.service ?? '').toLowerCase();
      const collectedAt = new Date().toISOString();
      // Tracks which evidence IDs have already been added to queueMetricEvIds so
      // a panel matching multiple queues doesn't insert the same ID twice.
      const seenQueueMetricEvIds = new Set<string>();

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
          // Promote a latency/error-rate spike to a CAUSE when it's scoped to the
          // investigated service OR — with no --service — when the panel/labels match the
          // hint (HOR-328 round-2: a "scheduler run duration latency spike" hint must lift
          // the matching x139 anomaly into a cause, not leave it unranked in evidence).
          const matchesService =
            serviceFilter.length > 0 &&
            (panelLower.includes(serviceFilter) || labelVals.some((v) => v.includes(serviceFilter)));
          // Only promote on a hint match when the hint is actually PERFORMANCE-flavored —
          // else a latency panel named after a domain noun (e.g. "GetProduct p95") gets
          // lifted into the cause for any "product …" hint and metric-anomaly headlines
          // everything (round-2 over-fire).
          const hintIsPerf =
            /\b(latenc|slow|spike|perf|throughput|duration|p9[5-9]|timeout|response\s*time|degrad)/i.test(
              hint,
            );
          const matchesHint =
            serviceFilter.length === 0 &&
            hintIsPerf &&
            hintTokens.some(
              (t) => t.length >= 4 && (panelLower.includes(t) || labelVals.some((v) => v.includes(t))),
            );
          if (matchesService || matchesHint) latencyMetricEvIds.push(ev.id);
        } else if (f.anomaly === 'queue-growth') {
          // Attribute each queue-growth anomaly to the specific queue(s) it matches.
          // Match using normalized panel/label strings with word-boundary checks so
          // 'orders' does not match inside 'preorders'. Store under canonical queue name
          // so hypothesis lookup (which uses original case) finds the entry.
          const panelNorm = f.panelTitle.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const labelNorms = Object.values(f.labels).map(
            (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
          );
          for (const [norm, canonical] of queueNormToCanonical) {
            const escaped = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(`(?:^| )${escaped}(?:$| )`);
            const matchesQueue = re.test(panelNorm) || labelNorms.some((lv) => re.test(lv));
            if (matchesQueue) {
              if (!seenQueueMetricEvIds.has(ev.id)) {
                seenQueueMetricEvIds.add(ev.id);
                queueMetricEvIds.push(ev.id);
              }
              const list = queueMetricEvIdsByQueue.get(canonical) ?? [];
              if (!list.includes(ev.id)) list.push(ev.id);
              queueMetricEvIdsByQueue.set(canonical, list);
            }
          }
        }
      }
      // Metrics were collected but found NO anomaly: record a neutral evidence item so
      // the result is part of the investigation (visible in replay/postmortem, closes the
      // metrics gap, and acts as contradicting context for any metric-driven hypothesis).
      metricSeriesChecked = mFindings.length;
      if (metricEvIds.length === 0 && mFindings.length > 0) {
        const panels = [...new Set(mFindings.map((f) => f.panelTitle))];
        const ev = mkEv(
          'metric',
          `Metrics checked — ${mFindings.length} series across ${panels.length} panel(s), no anomalies in window`,
          { seriesChecked: mFindings.length, panelCount: panels.length, panels: panels.slice(0, 10), anomalies: 0, stance: 'neutral' },
          {},
          collectedAt,
          0.2,
        );
        nominalMetricEvIds.push(ev.id);
      }
      // Set only after the full collection + conversion loop completes without error.
      metricsCollected = true;
    } catch (metricsErr) {
      // Metrics failure (including timeout) must never break the investigation.
      // metricsCollected stays false — gap detector will report the failure + reason.
      metricsFailureReason = (metricsErr as Error)?.message?.slice(0, 120) ?? 'unknown error';
    } finally {
      // Always clear the timer to prevent it from firing after a fast response
      // and to release the reference regardless of the outcome.
      if (metricsTimerId !== undefined) clearTimeout(metricsTimerId);
    }
  }

  // e0e. OWNERSHIP (HOR-20 / HOR-40) — estimate likely maintainer from git history.
  // Reuses the already-resolved seed symbol to skip a duplicate source-intelligence search.
  // Optional; needs repoPath AND a resolved seed + source provider — skipped in
  // degraded runtime-only mode. Never breaks on failure.
  let ownershipEstimate: OwnershipEstimate | null = null;
  if (deps.repoPath && top && code) {
    try {
      ownershipEstimate = await estimateOwnership(top.name, {
        code,
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
    queueBacklogEvIdsByQueue,
    queueStarvationEvIdsByQueue,
    queueMetricEvIdsByQueue,
    sinceProvided: input.since !== undefined,
    graph,
  });

  // e4. HYPOTHESIS VALIDATION (HOR-25) — adjust confidence + assign verdicts
  const validated = validateHypotheses(hyps, evidence);

  // e4a. CAUSE CHAINS (HOR-196) — build ordered causal sequences for supported hypotheses
  const causeChains = buildCauseChains(validated, evidence, graph, label);

  // f. FINDINGS (label kept as 'e' externally but shifted to 'f' internally)
  const findings: ReportFinding[] = [];

  // The seed is the best-ranked candidate (architectural entry point preferred).
  // Structural seed findings are present only on a full run (HOR-319 layer-2).
  if (top && seedEv) {
    findings.push({
      kind: 'observation',
      title: `Seed resolves to ${label} at ${seedLoc}`,
      detail: top.signature ?? undefined,
      confidence: 1,
      evidenceIds: [seedEv.id],
    });
  }

  // HOR-216: when the seed came from a log match (raw error-string hint), record
  // how it was resolved so the trail from "error string" → symbol is transparent.
  if (logReseed !== null && seedEv) {
    findings.push({
      kind: 'observation',
      title: logReseed.note,
      detail: 'Seed was resolved by matching the hint against recent logs, not source search.',
      confidence: 0.6,
      evidenceIds: [seedEv.id],
    });
  }

  // Surface the other ranked candidate areas so a narrow pick is transparent.
  if (ranked.length > 1 && seedEv) {
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

  if (top && impactEv && impact && impact.affected > 0) {
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
  } else if (!changes && changeEvId && recentChanges) {
    findings.push({
      kind: 'observation',
      title: `${recentChanges.commits.length} commit(s) in ${input.since}..HEAD touching ${recentChanges.changedFiles.length} file(s)`,
      confidence: clamp01(0.3 + Math.min(recentChanges.commits.length, 10) / 20),
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

    const hasDirectEvidence = directLogEvIds.length > 0;
    const ambientCount = ambientLogEvIds.length;

    // Summary finding — label when evidence is entirely ambient so users know
    // these errors have no established link to the seed.
    const ambientSuffix =
      !hasDirectEvidence && ambientCount > 0
        ? ` (${ambientCount} ambient — no direct link to seed established)`
        : ambientCount > 0
          ? ` (${directLogEvIds.length} direct, ${ambientCount} ambient)`
          : '';

    findings.push({
      kind: 'observation',
      title: `${analysis.signatures.length} error signature(s) (${newN} new, ${analysis.totalErrors} error(s)) — affected: ${affected}${ambientSuffix}`,
      confidence: hasDirectEvidence ? 0.65 : 0.40,
      evidenceIds: logEvIds,
    });

    // Top-signature finding: prefer the top direct hit; fall back to top overall
    // with an explicit "ambient" label so the user knows it's unlinked.
    const topDirectId = directLogEvIds[0];
    const topSig = analysis.signatures[0];
    if (topDirectId !== undefined && topSig !== undefined) {
      const flag = topSig.isNew
        ? ' (NEW)'
        : topSig.ratio !== undefined && Number.isFinite(topSig.ratio) && topSig.ratio >= 1.5
          ? ` (spike x${topSig.ratio.toFixed(1)})`
          : '';
      findings.push({
        kind: 'anomaly',
        title: `Top error signature: ${topSig.key} — ${topSig.count}x${flag}, last ${shortTs(topSig.lastSeen)}`,
        confidence: 0.7,
        evidenceIds: [topDirectId],
      });
    } else if (topSig !== undefined && ambientCount > 0) {
      const flag = topSig.isNew
        ? ' (NEW)'
        : topSig.ratio !== undefined && Number.isFinite(topSig.ratio) && topSig.ratio >= 1.5
          ? ` (spike x${topSig.ratio.toFixed(1)})`
          : '';
      findings.push({
        kind: 'observation',
        title: `Top error signature (ambient): ${topSig.key} — ${topSig.count}x${flag} — no structural link to seed`,
        confidence: 0.35,
        evidenceIds: ambientLogEvIds.slice(0, 1),
      });
    }
  }

  // Distinct failing-entity finding (HOR-215) — aggregated entity counts behind
  // the dominant error signature, so the report names what's actually stuck.
  if (entityEvIds.length > 0) {
    findings.push({
      kind: 'observation',
      title: `Distinct failing entities: ${entitySummaries.join(' × ')}`,
      confidence: 0.6,
      evidenceIds: entityEvIds,
    });
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

  // Redis runtime-state findings (HOR-201)
  if (redisStateAnalysis !== null && redisStateEvIds.length > 0) {
    const dbCount = redisStateAnalysis.databases.filter((d) => d.keyCount > 0).length;
    findings.push({
      kind: 'observation',
      title: `Redis runtime state: ${redisStateEvIds.length} signal(s) across ${dbCount} DB(s)`,
      confidence: 0.5,
      evidenceIds: redisStateEvIds,
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
  } else if (nominalMetricEvIds.length > 0) {
    // Metrics checked, nothing anomalous — record as a neutral observation so the
    // investigation reflects that metrics were inspected and are not implicated (HOR-203).
    findings.push({
      kind: 'observation',
      title: `Metrics nominal — ${metricSeriesChecked} series checked, no anomalies in window`,
      confidence: 0.5,
      evidenceIds: nominalMetricEvIds,
    });
  }

  // f. SUSPECTED CAUSES — build CauseInput list; scoring + ranking via rankCauses (HOR-15).
  const causeInputs: CauseInput[] = [];
  const blastRadius = impact?.affected ?? 0;

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
      sourceEvidenceIds: [...evIds, ...(impactEv ? [impactEv.id] : [])],
      baseScore: 0.35,
      metadata: { blastRadius },
    });
  }

  if (changeEvId) {
    // File-overlap boost: if the seed's file appears among changed files, the
    // deployment-regression hypothesis is more likely — raise base score to 0.45.
    // In degraded runtime-only mode there is no seed, so the cause is offered
    // generically off the git-history evidence alone.
    const gitChangedFiles = recentChanges?.changedFiles ?? [];
    const seedFile = top?.filePath;
    const seedInChanges =
      seedFile !== undefined &&
      gitChangedFiles.length > 0 &&
      gitChangedFiles.some((f) => f === seedFile || seedFile.endsWith(f) || f.endsWith(seedFile));
    // HOR-333: cite the actual culprit — the most-recent commit(s) (short SHA + subject)
    // and the changed symbol name(s) — so the cause names what to look at, not just the
    // seed + range. Bounded to 1-2 commits and a few symbols to stay scannable.
    const citation = formatRegressionCitation(recentChanges, changes, seedFile);
    // #3: only attribute the regression to the seed when an in-window commit actually touched the
    // seed's file. Otherwise be honest — changes shipped, but none to the seed — instead of
    // pinning it on the newest unrelated commit.
    const regressionTitle =
      top && seedInChanges
        ? `Recent change${citation.commitClause} to ${top.name}${citation.symbolClause} in ${input.since}..HEAD may have introduced the regression`
        : top
          ? `Changes shipped in ${input.since}..HEAD but none touched ${top.name} — a regression here is unlikely to be a code change to the seed itself (check upstream deps, data, or config)`
          : `Recent change${citation.commitClause}${citation.symbolClause} in ${input.since}..HEAD may have introduced the regression`;
    causeInputs.push({
      id: 'cause:deployment-regression',
      title: regressionTitle,
      category: 'deployment-regression',
      sourceEvidenceIds: [changeEvId, ...(seedEv ? [seedEv.id] : [])],
      // A regression NOT backed by a seed-touching commit must not score like one that is.
      baseScore: clamp01((seedInChanges ? 0.45 : 0.18) + (queueHits.length > 0 ? 0.05 : 0)),
      metadata: { blastRadius },
    });
  }

  // Blast-radius cause: offered only when a resolved symbol has GENUINE reach.
  // "1 affected" is no fan-out — offering it produced a tautological top cause
  // ("sits on a high-fan-out path (1 affected)") that led the ranking on pure
  // topology while real (error/data) signals sat unranked (HOR-340). Require a
  // real fan-out threshold before this structural observation can be a cause.
  const MIN_FANOUT_FOR_CAUSE = 3;
  if (top && impactEv && seedEv && impact && impact.affected >= MIN_FANOUT_FOR_CAUSE) {
    causeInputs.push({
      id: 'cause:blast-radius',
      title: `${top.name} has wide code reach (${impact.affected} dependent symbols) and may propagate the fault`,
      category: 'blast-radius',
      sourceEvidenceIds: [impactEv.id, seedEv.id],
      baseScore: clamp01(0.15 + (queueHits.length > 0 ? 0.05 : 0)),
      metadata: { blastRadius },
    });
  }

  // HOR-341: SEED-EMITTED runtime-error cause — the strongest possible link. When a
  // runtime error's literal is RAISED FROM the seed's own source body (e.g. maison's
  // `E_FULFILLMENT_SYNC_ERROR_04` thrown inside `checkBrandOrderFulfillment`) AND that
  // exact code has live Elasticsearch occurrences, the seed is observably failing in
  // production — not merely co-occurring. The cross-signal join surfaced it as direct
  // evidence but it never became a CAUSE (and when the code was also a top signature the
  // dedup buried it as a "lead to verify"). Promote it to a dedicated headline cause that
  // cites BOTH the join evidence and the seed symbol, so the #1/#2 structural-link gate
  // treats it LINKED and the "no cause is structurally linked" reframing yields to it.
  if (seedEmittedJoins.length > 0 && top && seedEv) {
    // Headline the highest-volume seed-emitted error; cite each as supporting evidence.
    const ordered = [...seedEmittedJoins].sort((a, b) => b.count - a.count);
    const lead = ordered[0];
    if (lead !== undefined) {
      const sourceEvidenceIds = [
        ...new Set([...ordered.map((j) => j.evId), seedEv.id]),
      ];
      // Strong prior so it headlines (~0.6–0.7), scaled up by occurrence volume: a
      // recurring raise (thousands of hits) is more certainly THE failure than a handful.
      const volumeBoost = Math.min(0.1, Math.log10(Math.max(1, lead.count)) * 0.025);
      const baseScore = clamp01(0.6 + volumeBoost);
      const msgClause = lead.message
        ? ` — "${lead.message.replace(/\s+/g, ' ').trim().slice(0, 90)}"`
        : '';
      causeInputs.push({
        id: 'cause:seed-emitted-error',
        title:
          `Runtime error ${lead.code} (${lead.count}x in Elasticsearch) is raised by ${top.name} — the likely failure${msgClause}`.slice(
            0,
            220,
          ),
        category: 'error-correlation',
        sourceEvidenceIds,
        baseScore,
        metadata: { blastRadius, seedEmitted: true, code: lead.code, count: lead.count },
      });
    }
  }

  // Runtime-errors + queue-path cause: only when we have DIRECT error evidence AND a queue path.
  // Ambient-only signatures have no structural link to the seed and must not drive
  // cause ranking — they inflate confidence on unrelated high-volume errors.
  if (analysis !== null && analysis.signatures.length > 0 && queueHits.length > 0 && directLogEvIds.length > 0) {
    const firstQueue = queueHits[0];
    const queueLabel =
      firstQueue !== undefined
        ? `"${firstQueue.queueName}" (${firstQueue.producerSymbol ?? 'unknown'} -> ${firstQueue.workerSymbol ?? 'unknown'})`
        : 'the queue path';
    // HOR-338: cite the DIRECT errors (those linked to the seed/path), not the global
    // top/total — otherwise a louder, unrelated error from another service/host is
    // narrated onto this path purely by co-occurrence.
    const directTotal = directSignatures.reduce((sum, d) => sum + d.count, 0);
    const directTop = directSignatures[0];
    causeInputs.push({
      id: 'cause:error-correlation',
      title: `Runtime errors (${directTotal}${directTop ? `, top ${directTop.key}` : ''}) directly linked to the implicated queue path ${queueLabel}`,
      category: 'error-correlation',
      sourceEvidenceIds: directLogEvIds.slice(0, 3),
      baseScore: 0.30,
      metadata: { blastRadius },
    });
  }

  // HOR-328 round-2: synthesize a network/dependency cause from the dominant DIRECT error
  // MESSAGE. The real cause (a DNS/connection failure like "getaddrinfo ENOTFOUND host") is
  // often verbatim in the message yet never promoted, so the headline defaulted to a
  // co-occurring metric/stale signal instead of the actual outage. This is a strong,
  // evidence-backed cause that should lead.
  const INFRA_RE =
    /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ECONNRESET|getaddrinfo|socket hang up|connection (?:refused|reset|timed out)|network (?:error|timeout)|DNS)\b/i;
  const infraSig = directSignatures.find((d) => INFRA_RE.test(d.message));
  // Only headline a queue failure that is RELEVANT to this investigation — otherwise a single
  // stale failing queue (e.g. one GAIA DNS error days old) gets narrated onto every unrelated
  // hint (round-3 over-fire). Relevant = the queue is a static hit for this investigation, or
  // its name overlaps the hint tokens (so "gaia stock sync" matches GAIA_STOCK_SYNC, but an
  // Emoda/HMAC/fulfillment hint does not).
  const queueHitNames = new Set(queueHits.map((e) => e.queueName.toLowerCase()));
  const infraQueue = queueFailureSignals.find((q) => {
    if (!INFRA_RE.test(q.reason)) return false;
    if (queueHitNames.has(q.queueName.toLowerCase())) return true;
    const qTokens = new Set(tokenize(q.queueName));
    return hintTokens.some((t) => t.length >= 3 && qTokens.has(t));
  });
  if (infraSig) {
    causeInputs.push({
      id: 'cause:dependency-failure',
      title: `Dependency/network failure: ${infraSig.count}x ${infraSig.key} — "${infraSig.message.replace(/\s+/g, ' ').trim().slice(0, 100)}"`,
      category: 'infrastructure',
      sourceEvidenceIds: directLogEvIds.slice(0, 3),
      baseScore: 0.5,
      metadata: { blastRadius },
    });
  } else if (infraQueue) {
    // The DNS/connection failure can surface ONLY in queue forensics, never the live error
    // stream (the GAIA case: the real cause was an ENOTFOUND in the queue's failed jobs).
    // Promote it so the headline is the actual outage, not a co-occurring stale-collection.
    causeInputs.push({
      id: 'cause:dependency-failure',
      title: `Dependency/network failure on queue ${infraQueue.queueName}: ${infraQueue.count} failed job(s) — "${infraQueue.reason.replace(/\s+/g, ' ').trim().slice(0, 100)}"${infraQueue.stale ? ' (stale — reflects a past run)' : ''}`,
      category: 'infrastructure',
      sourceEvidenceIds: [infraQueue.evId],
      // A stale-only queue failure is weaker than a live error, but still the best
      // explanation — and far better than a co-occurring stale-collection guess.
      baseScore: infraQueue.stale ? 0.34 : 0.5,
      metadata: { blastRadius },
    });
  }

  // HOR-332: data-state anomaly cause — records stuck in a failed/stale state are a
  // data-quality root-cause class, not just a finding. Many prod incidents are data
  // (stale/orphaned records), not code, and Horus otherwise anchors only on code.
  if (dataAnomalyEvIds.length > 0) {
    const collections = [...new Set(dataAnomalyCollections)];
    const example = collections[0];
    causeInputs.push({
      id: 'cause:data-state-anomaly',
      // Co-occurring, NOT asserted as the root cause: the stale collection is selected by
      // hint relevance, not proven reachable from the seed's call graph, so claiming it is
      // the cause mislead on e.g. a Shopify-fulfillment error citing unrelated gaia sync logs.
      title: `Data-state anomaly (co-occurring): ${collections.length} collection(s) hold records in a failed/stale state${example ? ` (e.g. ${example})` : ''} — verify whether it relates to this failure`,
      category: 'data-state-anomaly',
      sourceEvidenceIds: dataAnomalyEvIds.slice(0, 3),
      baseScore: 0.22,
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
    ...(deps.mongo != null || deps.redisState != null ? { state: 0.85 } : {}),
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

  // g. confidence
  // Pass ambient log IDs so unlinked runtime noise is weighted like structural
  // evidence rather than live confirmed signal (HOR-158).
  const evidenceConfidence = computeWeightedEvidenceConfidence(
    evidence,
    ambientLogEvIds.length > 0 ? new Set(ambientLogEvIds) : undefined,
  );
  // Without a seed (degraded runtime-only mode) seedResolved is 0, so this formula
  // already caps confidence at ≤0.5 — runtime evidence can never look as certain as a
  // full structural run (HOR-319 layer-2).
  // A fuzzy/zero-support seed (HOR-335) is only partially "resolved" — it must not
  // earn the full +0.5 a real, hint-matched seed does.
  const seedResolved = seeds.length === 0 ? 0 : seedIsLowConfidence ? 0.3 : 1;
  let confidence = clamp01(0.5 * evidenceConfidence + 0.5 * seedResolved);

  // h. summary
  const area = ctx?.community?.name ?? top?.filePath ?? (input.service ?? 'runtime evidence');
  const topCause = rankedCauses[0];
  // HOR — gate the headline on a STRUCTURAL LINK to the seed. A cause is "linked" when it cites
  // the seed's own evidence (its symbol / blast-impact) or a direct (seed-tied) log signature —
  // as opposed to purely co-occurring runtime noise (an unrelated stale queue, a data-state
  // anomaly on another table, ambient errors). Prefer the strongest LINKED cause; an unlinked
  // top cause only headlines when nothing linked clears the bar, and is then framed honestly.
  const seedLinkedEvIds = new Set<string>([
    ...directLogEvIds,
    ...(seedEv ? [seedEv.id] : []),
    ...(impactEv ? [impactEv.id] : []),
  ]);
  const isLinkedToSeed = (ids: string[]): boolean => ids.some((id) => seedLinkedEvIds.has(id));
  // HOR-340/336: a sub-threshold cause (e.g. a weak blast-radius ~0.09) must not headline as a
  // confident diagnosis; below the bar it stays listed but the summary says "no dominant".
  const topLinkedCause = rankedCauses.find(
    (c) => c.finalScore >= 0.2 && isLinkedToSeed(c.sourceEvidenceIds),
  );
  const headlineCause =
    topLinkedCause ?? (topCause && topCause.finalScore >= 0.2 ? topCause : undefined);
  const headlineLinked = headlineCause !== undefined && isLinkedToSeed(headlineCause.sourceEvidenceIds);
  // #2 calibration — a headline that isn't structurally linked to the seed is a co-occurring
  // signal, not a verified diagnosis: cap it in the "possible" band so it never reads as a
  // confident "likely" diagnosis (and so confidence actually discriminates linked vs not).
  if (headlineCause && !headlineLinked) confidence = Math.min(confidence, 0.6);
  const banner = degradedNoSource ? 'Runtime-only (source intelligence unavailable). ' : '';
  const scope = top ? `resolved to ${label} (${area})` : `over runtime evidence (${area})`;
  // HOR-335: lead with an honest disclaimer when the seed is only a semantic guess.
  const seedDisclaimer =
    seedIsLowConfidence && top
      ? `⚠ No symbol closely matched "${hint}" — "${top.name}" is a low-confidence closest match (semantic). Refine with an exact symbol or error code to target precisely. `
      : '';
  let summary = headlineCause
    ? headlineLinked
      ? `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. Top suspected cause: ${headlineCause.title}.`
      : `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. No cause is structurally linked to the seed; the strongest co-occurring signal (a lead to verify, not a diagnosis) is: ${headlineCause.title}.`
    : `${seedDisclaimer}${banner}Investigation of "${hint}" ${scope}. No dominant suspected cause emerged from the available ${degradedNoSource ? 'runtime' : 'structural'} evidence.`;

  // HOR-334: a behavioral "how does X work" hint with NO real incident signal is a
  // request for an explanation, not a fault hunt. Rather than dumping empty incident
  // sections (no errors, no anomalies, no failing queues), lead the user to the
  // focused `horus explain <symbol>` answer. Conservative: only fires when the hint
  // reads as a question AND nothing actually looks wrong — a real incident (even with
  // a question-shaped hint) still gets a normal investigation.
  const hasIncidentSignal =
    directLogEvIds.length > 0 ||
    latencyMetricEvIds.length > 0 ||
    queueMetricEvIds.length > 0 ||
    dataAnomalyEvIds.length > 0 ||
    queueFailureSignals.length > 0 ||
    findings.some((f) => f.kind === 'anomaly') ||
    headlineCause !== undefined;
  const explanatoryHint = looksExplanatory(hint) && !hasIncidentSignal;
  if (explanatoryHint) {
    const explainTarget = top?.name ?? input.service ?? hint;
    summary =
      `${seedDisclaimer}${banner}"${hint}" reads as a "how does it work" question and no incident signal was found ` +
      `(no error signatures, anomalies, or failing queues). For a focused answer, run \`horus explain ${explainTarget}\`. ` +
      `${top ? `Investigated ${label} (${area}); the` : 'The'} incident sections below are empty by design — this is not a fault hunt.`;
  }

  // i. nextActions
  const nextActions = buildNextActions(top, ctx, impact, queueHits, changes, input);
  // HOR-334: for an explanatory hint with no incident signal, lead with the focused
  // `horus explain` action so the user is steered to the right tool first.
  if (explanatoryHint) {
    const explainTarget = top?.name ?? input.service ?? hint;
    nextActions.unshift(
      `This looks like a behavioral question — run \`horus explain ${explainTarget}\` for a focused walkthrough of how it works.`,
    );
  }
  if (degradedNoSource) {
    nextActions.unshift(
      'Source intelligence was unavailable — run `horus index` to enable code-aware analysis, then re-run for a full investigation.',
    );
  }

  // Prepend owner routing when ownership is known (HOR-40) — but not for a fuzzy
  // seed (HOR-335): routing a maintainer for a fabricated seed is false authority.
  if (ownershipEstimate?.likelyMaintainer && !seedIsLowConfidence) {
    nextActions.unshift(
      `Route to likely maintainer: ${ownershipEstimate.likelyMaintainer} (${Math.round(ownershipEstimate.maintainerShare * 100)}% of commits to ${ownershipEstimate.file ?? top?.filePath ?? 'the implicated file'})`,
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
    causeChains: causeChains.length > 0 ? causeChains : undefined,
    ...(recentChanges !== undefined ? { recentChanges } : {}),
    ...(degradedNoSource
      ? { degraded: { sourceIntelligence: false, reason: 'source-intelligence host unreachable' } }
      : {}),
  };

  // HOR-19 — compute gap analysis and cap confidence BEFORE persisting so the
  // persisted record reflects the capped value.
  const connectorFlags: ConnectorFlags = deps.connectors
    ? {
        ...deps.connectors,
        // The queue connector is configured iff a BullMQ provider was constructed
        // (queueForEnv returns null without a bullmq/queues Redis DB) — HOR-205.
        queue: deps.queue != null,
        // Sentry is configured iff a provider was built; sentryCollected tracks whether
        // its collection ran (distinguishes "no open issues" from "collection failed").
        sentry: deps.sentry != null,
        sentryCollected,
        metricsCollected,
        metricsFailureReason,
        logsCollected,
        logsCompatibilityError,
        sinceProvided: input.since !== undefined,
      }
    : {
        elasticsearch: deps.logs != null,
        mongodb: deps.mongo != null,
        postgres: deps.postgres != null,
        sentry: deps.sentry != null,
        sentryCollected,
        grafana: deps.metrics != null,
        queue: deps.queue != null,
        metricsCollected,
        metricsFailureReason,
        logsCollected,
        logsCompatibilityError,
        sinceProvided: input.since !== undefined,
      };
  const gapAnalysis = detectMissingEvidence(report, connectorFlags);
  report.gapAnalysis = gapAnalysis;
  report.confidence = Math.min(report.confidence, gapAnalysis.confidenceCeiling);
  // HOR-335: a fuzzy/zero-support seed can never claim more than low confidence,
  // regardless of how much (unrelated) runtime evidence happens to be present.
  if (seedIsLowConfidence) report.confidence = Math.min(report.confidence, 0.45);
  // HOR-336: the headline must reflect DIAGNOSIS strength, not just localization +
  // evidence volume. A run can localize a seed and surface lots of evidence yet
  // produce no meaningful root cause — that is "localized, cause unknown", not a
  // confident diagnosis. When no cause clears a meaningful bar (the cause scale is
  // compressed; real causes score ~0.3+), cap the headline so it can't read 0.85
  // over a 0.08 cause (or none at all). The ceiling is MONOTONIC in the headline
  // cause score: a modest cause (0.2–0.5) caps confidence to ~0.6–0.78; only a
  // strong cause (>=~0.5) permits high confidence. It is only ever a ceiling —
  // it never raises confidence.
  const topCauseScore = report.suspectedCauses[0]?.finalScore ?? 0;
  report.confidence = Math.min(report.confidence, confidenceCeilingForCause(topCauseScore));
  report.nextActions.push(...gapNextActions(gapAnalysis.gaps));
  report.sourceStatus = buildRuntimeSourceStatus(evidence, connectorFlags);

  // j. PERSIST — may overwrite report.id with the DB-assigned id.
  const persistedId = await persist(db, input, report);
  if (persistedId) report.id = persistedId;
  // Record whether the report actually reached the investigation store so callers
  // can warn that a display-only run won't be retrievable via `horus ask`.
  report.persisted = persistedId !== null;

  // k. INCIDENT MEMORY (HOR-18) — recall similar past incidents THEN store.
  //    Past incidents are CONTEXT ONLY; they must never override report.confidence.
  if (persistedId !== null) {
    const tags = deriveTags(report);
    report.similarIncidents = await recallSimilar(db, tags, persistedId, input.repo ?? null);
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

/**
 * Deterministic, name-bearing next-step suggestions. `top`/`ctx`/`impact` are absent in
 * degraded runtime-only mode (HOR-319 layer-2), where the suggestions key off the queue
 * and service scope instead of a resolved symbol.
 */
function buildNextActions(
  top: Symbol | undefined,
  _ctx: SymbolContext | null,
  impact: ImpactResult | null,
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
  if (top && impact && impact.affected > 0) {
    actions.push(`Review impact set of ${top.name} (${impact.affected} affected symbol(s))`);
  }
  if (top) {
    if (changes && input.since !== undefined) {
      actions.push(`Diff recent commits touching ${top.filePath} in ${input.since}..HEAD`);
    } else {
      actions.push(`Diff recent commits touching ${top.filePath}`);
    }
  }
  if (actions.length === 0) {
    actions.push(
      top
        ? `Inspect the source of ${top.name} at ${top.filePath}`
        : input.service
          ? `Inspect runtime logs and metrics for service "${input.service}"`
          : 'Inspect runtime logs and metrics for the affected service',
    );
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
