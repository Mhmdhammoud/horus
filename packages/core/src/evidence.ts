/**
 * The Evidence model — the universal currency between providers, the engine, and the
 * LLM. Everything the AI sees is a typed, attributable `Evidence`; no raw provider
 * blobs reach the model. See architecture.md §2.5.
 */

/** Which kind of system produced a piece of evidence. */
export type ProviderKind =
  | 'code' // Axon
  | 'logs' // Elasticsearch
  | 'metrics' // Prometheus
  | 'state' // Redis / MongoDB
  | 'queue' // BullMQ
  | 'history'; // Git

/**
 * Cross-provider severity scale, assigned by the normalization layer (never by
 * providers). `critical` and `high` are actionable anomalies; `info` is
 * structural context that enriches the picture without signalling a problem.
 */
export type EvidenceSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * Broad functional category for grouping and filtering across providers.
 * Assigned by the normalization layer, not by individual providers.
 */
export type EvidenceCategory =
  | 'queue'      // BullMQ backlog, starvation, failures
  | 'database'   // MongoDB state anomalies
  | 'logs'       // Elasticsearch error patterns
  | 'code'       // Axon symbols, flows, impact blast-radius
  | 'deployment' // Git commits
  | 'metrics'    // Grafana time-series
  | 'other';

/** The shape of a single evidence item. */
export type EvidenceKind =
  | 'log'
  | 'metric'
  | 'symbol'
  | 'flow'
  | 'commit'
  | 'queue-state'
  | 'queue-edge'
  | 'redis-key'
  | 'state' // application/DB state (MongoDB)
  | 'impact';

/** Graph back-references that let a human (or the engine) jump to the source. */
export interface EvidenceLinks {
  file?: string;
  line?: number;
  symbolId?: string;
  commit?: string;
  traceId?: string;
  queueName?: string;
}

export interface Evidence {
  /** Stable, citable id, e.g. `ev_log_01H...`. The AI must reference these. */
  id: string;
  source: ProviderKind;
  kind: EvidenceKind;
  /** Human-readable one-line summary. */
  title: string;
  /** ISO timestamp, for timeline alignment. */
  timestamp?: string;
  /** Engine-assigned relevance, 0–1. */
  relevance: number;
  /** Typed per `kind`; opaque to the engine, structured for the renderer/AI. */
  payload: unknown;
  links: EvidenceLinks;
  /** Reproducibility: the query that produced this and when. */
  provenance: { query: string; collectedAt: string };
  /** Assigned by the normalization layer; absent until normalizeEvidence() runs. */
  severity?: EvidenceSeverity;
  /** Broad functional grouping; assigned by the normalization layer. */
  category?: EvidenceCategory;
}

/** A resolved code symbol, as returned by the code provider. */
export interface Symbol {
  id: string;
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  signature?: string;
  language?: string;
  className?: string;
}

/** A reference to an Axon community node. */
export interface CommunityRef {
  id: string;
  name: string;
}

/** A file that co-changes frequently with another (git coupling). */
export interface CoupledFile {
  file: string;
  coChanges: number;
}

/** Raw result from a Cypher query. */
export interface CypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
}

/** Result of an impact analysis rooted at a symbol. */
export interface ImpactResult {
  target: Symbol;
  affected: number;
  byDepth: { depth: number; symbols: Symbol[] }[];
}

/** Added/removed/modified symbols between two refs. */
export interface ChangeSet {
  added: Symbol[];
  removed: Symbol[];
  modified: { before: Symbol; after: Symbol }[];
}

/** Callers + callees of a symbol (Axon `context`), enriched with graph neighbours. */
export interface SymbolContext {
  symbol: Symbol;
  snippet?: string; // short excerpt of the symbol's source
  callers: Symbol[];
  callees: Symbol[];
  imports: string[]; // file paths the symbol's defining file imports
  usesType: Symbol[]; // TypeAlias/Interface the symbol uses
  community: CommunityRef | null;
  coupledWith: CoupledFile[]; // git-coupled files
  isDead?: boolean;
}

/** A pre-computed multi-hop execution flow (Axon `Process` node). */
export interface Flow {
  id: string;
  name: string;
  steps: Symbol[];
}

/** Status of a provider, surfaced by `horus status`. */
export interface HealthStatus {
  ok: boolean;
  detail: string;
}
