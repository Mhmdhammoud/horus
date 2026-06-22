/**
 * On-disk layout for the local knowledge index (HOR-291).
 *
 * Lives under the repo's `.horus/` directory, alongside `source/` and
 * `config.json`:
 *
 *   .horus/index/
 *     manifest.json         # index entrypoint: versions, repos, counts, files
 *     knowledge-base.json   # CANONICAL full KnowledgeSnapshot
 *     contracts.json        # derived view: operations + types + enums + authRules
 *     domain-concepts.json  # derived view: domainConcepts
 *     data-flows.json       # derived view: dataFlows
 *     runtime-map.json      # derived view: runtimeComponents + externalIntegrations
 *     source-index.json     # optional pointer/summary into source intelligence
 *     index.db              # OPTIONAL (v2) SQLite for fast/semantic lookup
 *
 * The split view files are human-readable, git-diffable projections for
 * debugging and partial reads; `knowledge-base.json` is the source of truth.
 */
import { join } from 'node:path';

/** The repo-local Horus dir (mirrors `@horus/core` discovery.HORUS_DIR). */
export const HORUS_DIR = '.horus';
/** Sub-directory holding the knowledge index. */
export const KNOWLEDGE_DIR = 'index';

export const KNOWLEDGE_FILES = {
  manifest: 'manifest.json',
  knowledgeBase: 'knowledge-base.json',
  contracts: 'contracts.json',
  domainConcepts: 'domain-concepts.json',
  dataFlows: 'data-flows.json',
  runtimeMap: 'runtime-map.json',
  sourceIndex: 'source-index.json',
  /** Optional SQLite index (v2, not written in v1). */
  db: 'index.db',
} as const;

export type KnowledgeFile = keyof typeof KNOWLEDGE_FILES;

/** Absolute path to `<root>/.horus/index`. */
export function knowledgeDir(root: string): string {
  return join(root, HORUS_DIR, KNOWLEDGE_DIR);
}

/** Absolute path to a known file inside the knowledge dir. */
export function knowledgePath(root: string, file: KnowledgeFile): string {
  return join(knowledgeDir(root), KNOWLEDGE_FILES[file]);
}
