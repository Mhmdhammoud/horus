/**
 * Knowledge-base import entrypoints (HOR-292).
 *
 * `importKnowledgeBaseFile` is the internal API behind a future
 * `horus knowledge import <file> --source maison-safqa-mcp` command: it reads a
 * JSON KB from disk, hashes it, maps it into a `KnowledgeSnapshot`, and (when a
 * repo root is given) persists it to `.horus/index/` with a provenance manifest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createJsonKnowledgeStore } from '../store.js';
import type { KnowledgeManifest } from '../schema.js';
import {
  importMaisonSafqaKnowledgeBase,
  MAISON_SAFQA_SOURCE,
  type ImportResult,
} from './maison-safqa.js';

export * from './maison-safqa.js';

export interface ImportFileOptions {
  /** Repo root to persist the snapshot under `.horus/index/`. Omit to import in-memory only. */
  root?: string;
  /** Source label for provenance (defaults to `maison-safqa-mcp`). */
  source?: string;
  /** Project name to scope the snapshot to. */
  project?: string;
  /** ISO timestamp for the snapshot (defaults to now). */
  now?: string;
}

export interface ImportFileResult extends ImportResult {
  /** sha256 of the imported file. */
  contentHash: string;
  /** Written manifest (only when `root` was provided). */
  manifest: KnowledgeManifest | null;
}

/** Import a Maison Safqa MCP knowledge-base JSON file into the local index. */
export function importKnowledgeBaseFile(
  filePath: string,
  opts: ImportFileOptions = {},
): ImportFileResult {
  const source = opts.source ?? MAISON_SAFQA_SOURCE;
  const content = readFileSync(filePath, 'utf8');
  const contentHash = createHash('sha256').update(content).digest('hex');

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Could not parse ${filePath} as JSON: ${(err as Error).message}`);
  }

  const result = importMaisonSafqaKnowledgeBase(raw, {
    now: opts.now,
    contentHash,
    project: opts.project,
  });

  let manifest: KnowledgeManifest | null = null;
  if (opts.root) {
    const store = createJsonKnowledgeStore(opts.root);
    manifest = store.write(result.snapshot, {
      generator: { tool: source, version: result.kbVersion ?? undefined },
      sourceIntelligence: { tool: source },
      extraFiles: [
        { name: `${source}:${basename(filePath)}`, category: 'import-source', contentHash },
      ],
    });
  }

  return { ...result, contentHash, manifest };
}
