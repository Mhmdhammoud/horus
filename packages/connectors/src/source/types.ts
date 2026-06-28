export interface SourceNode {
  id: string;
  label: string;
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string;
  language: string;
  className: string;
  isDead: boolean;
  isEntryPoint: boolean;
  isExported: boolean;
}

export interface SourceSearchResult {
  nodeId: string;
  score: number;
  name: string;
  filePath: string;
  label: string;
  snippet: string;
}

export interface SourceCypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
}

export interface SourceImpactResult {
  target: SourceNode;
  affected: number;
  depths: Record<string, SourceNode[]>;
}

export interface SourceDiffResult {
  added: SourceNode[];
  removed: SourceNode[];
  modified: { before: SourceNode; after: SourceNode }[];
  addedEdges: unknown[];
  removedEdges: unknown[];
}

export interface SourceOverview {
  nodesByLabel: Record<string, number>;
  edgesByType: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

export interface SourceHostInfo {
  repoPath: string;
  hostUrl: string;
  mcpUrl: string;
  watch: boolean;
  mode: string;
}

export interface SourceHealth {
  ok: boolean;
  status: number;
}

// ---------------------------------------------------------------------------
// Memory vector bridge (M2) — wire shapes for the host's /api/memory/* routes.
// Vectors are a DERIVED index; Postgres (M1) stays source-of-truth. These types
// mirror the host bridge in the spec (contract C: memory_index_upsert/search/remove).
// ---------------------------------------------------------------------------

/** POST /api/memory/upsert body. `scope` carries the recall specificity (symbol:/module:/repo/global). */
export interface SourceMemoryUpsertRequest {
  memoryId: string;
  claim: string;
  repo: string;
  scope: string;
}

/** POST /api/memory/search body. `repo` is required (fail-closed isolation, HOR-46). */
export interface SourceMemorySearchRequest {
  query: string;
  repo: string;
  limit: number;
}

/** A single scored candidate returned by the host vector search. `score` is cosine in 0..1. */
export interface SourceMemorySearchHit {
  memoryId: string;
  score: number;
}

/** POST /api/memory/search response envelope. */
export interface SourceMemorySearchResult {
  results: SourceMemorySearchHit[];
}
