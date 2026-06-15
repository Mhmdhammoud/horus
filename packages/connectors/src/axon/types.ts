export interface AxonNode {
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

export interface AxonSearchResult {
  nodeId: string;
  score: number;
  name: string;
  filePath: string;
  label: string;
  snippet: string;
}

export interface AxonCypherResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number;
}

export interface AxonImpactResult {
  target: AxonNode;
  affected: number;
  depths: Record<string, AxonNode[]>;
}

export interface AxonDiffResult {
  added: AxonNode[];
  removed: AxonNode[];
  modified: { before: AxonNode; after: AxonNode }[];
  addedEdges: unknown[];
  removedEdges: unknown[];
}

export interface AxonOverview {
  nodesByLabel: Record<string, number>;
  edgesByType: Record<string, number>;
  totalNodes: number;
  totalEdges: number;
}

export interface AxonHostInfo {
  repoPath: string;
  hostUrl: string;
  mcpUrl: string;
  watch: boolean;
  mode: string;
}

export interface AxonHealth {
  ok: boolean;
  status: number;
}

// Horus-facing aliases for the source-intelligence boundary (HOR-64).
// These sit in front of the Axon wire types; the implementation is unchanged.
export type SourceNode = AxonNode;
export type SourceSearchResult = AxonSearchResult;
export type SourceCypherResult = AxonCypherResult;
export type SourceImpactResult = AxonImpactResult;
export type SourceDiffResult = AxonDiffResult;
export type SourceOverview = AxonOverview;
export type SourceHostInfo = AxonHostInfo;
export type SourceHealth = AxonHealth;
