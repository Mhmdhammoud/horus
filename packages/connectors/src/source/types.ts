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
