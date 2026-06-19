/**
 * JSON-file knowledge store (HOR-291).
 *
 * The canonical v1 store is plain JSON under `.horus/index/` — human-readable,
 * git-diffable, no native deps, and queryable without embeddings (load + filter
 * in memory). A SQLite/vector layer (`index.db`) is a deferred v2 optimisation;
 * the store interface below is engine-agnostic so it can be added without
 * changing callers.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  KnowledgeManifestSchema,
  KnowledgeSnapshotSchema,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeManifest,
  type KnowledgeSnapshot,
} from './schema.js';
import { knowledgeDir, knowledgePath } from './layout.js';

/** Storage-agnostic contract for reading/writing the local knowledge index. */
export interface KnowledgeStore {
  /** True if a knowledge index exists for this repo. */
  exists(): boolean;
  /** Read + validate the manifest, or null if absent. */
  readManifest(): KnowledgeManifest | null;
  /** Read + validate the canonical snapshot, or null if absent. */
  readSnapshot(): KnowledgeSnapshot | null;
  /** Validate + persist a snapshot (canonical file, derived views, manifest). */
  write(snapshot: KnowledgeSnapshot, opts?: WriteOptions): KnowledgeManifest;
}

export interface WriteOptions {
  /** What produced this snapshot (recorded in the manifest). */
  generator?: { tool: string; version?: string };
  /** Repos + their indexed HEAD commit. */
  repositories?: { name: string; path?: string; headSha?: string }[];
  /** Source-intelligence backend this snapshot references (e.g. Axon). */
  sourceIntelligence?: { tool: string; version?: string };
  /** Git state the snapshot was built at (HOR-293). */
  git?: { sha?: string; branch?: string };
  /** Extra manifest file entries (e.g. an import source file + its content hash). */
  extraFiles?: { name: string; category?: string; itemCount?: number; contentHash?: string }[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/** Create a JSON-backed knowledge store rooted at a repo directory. */
export function createJsonKnowledgeStore(root: string): KnowledgeStore {
  const manifestPath = knowledgePath(root, 'manifest');
  const basePath = knowledgePath(root, 'knowledgeBase');

  return {
    exists() {
      return existsSync(basePath);
    },

    readManifest() {
      if (!existsSync(manifestPath)) return null;
      return KnowledgeManifestSchema.parse(readJson(manifestPath));
    },

    readSnapshot() {
      if (!existsSync(basePath)) return null;
      return KnowledgeSnapshotSchema.parse(readJson(basePath));
    },

    write(snapshot, opts = {}) {
      // Validate before touching disk so a bad snapshot never half-writes.
      const parsed = KnowledgeSnapshotSchema.parse(snapshot);

      const counts: Record<string, number> = {};
      for (const cat of KNOWLEDGE_CATEGORIES) counts[cat] = parsed[cat].length;

      // Content hash of the canonical snapshot (manifest integrity / freshness).
      const snapshotJson = JSON.stringify(parsed, null, 2) + '\n';
      const contentHash = createHash('sha256').update(snapshotJson).digest('hex');

      // Canonical full snapshot.
      mkdirSync(dirname(basePath), { recursive: true });
      writeFileSync(basePath, snapshotJson);

      // Derived, human-readable view files (subsets of the canonical snapshot).
      writeJson(knowledgePath(root, 'contracts'), {
        operations: parsed.operations,
        types: parsed.types,
        enums: parsed.enums,
        authRules: parsed.authRules,
      });
      writeJson(knowledgePath(root, 'domainConcepts'), {
        domainConcepts: parsed.domainConcepts,
      });
      writeJson(knowledgePath(root, 'dataFlows'), { dataFlows: parsed.dataFlows });
      writeJson(knowledgePath(root, 'runtimeMap'), {
        runtimeComponents: parsed.runtimeComponents,
        externalIntegrations: parsed.externalIntegrations,
      });

      const manifest: KnowledgeManifest = KnowledgeManifestSchema.parse({
        schemaVersion: parsed.schemaVersion,
        generatedAt: parsed.generatedAt,
        generator: opts.generator ?? { tool: 'horus-cli' },
        project: parsed.project,
        git: opts.git,
        repositories: opts.repositories ?? [],
        files: [
          { name: 'knowledge-base.json', contentHash },
          { name: 'contracts.json', category: 'contracts' },
          { name: 'domain-concepts.json', category: 'domainConcepts' },
          { name: 'data-flows.json', category: 'dataFlows' },
          { name: 'runtime-map.json', category: 'runtimeMap' },
          ...(opts.extraFiles ?? []),
        ],
        counts,
        sourceIntelligence: opts.sourceIntelligence,
      });
      writeJson(manifestPath, manifest);
      return manifest;
    },
  };
}

export { knowledgeDir };
