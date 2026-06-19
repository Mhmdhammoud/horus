/**
 * Lightweight, embedding-free query over a `KnowledgeSnapshot` (HOR-291/HOR-292).
 *
 * Enough for `horus knowledge search/contracts` (HOR-294) and to prove imported
 * knowledge is findable by name and keyword: case-insensitive substring matching
 * across each item's id, name, and a few descriptive fields. No index needed —
 * snapshots are small and load fully into memory.
 */
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory, type KnowledgeSnapshot } from './schema.js';

export interface KnowledgeMatch {
  category: KnowledgeCategory;
  id: string;
  /** Best display name for the item. */
  name: string;
  item: Record<string, unknown>;
}

/** The text fields searched per item, in addition to id + name. */
function searchableText(item: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of [
    'id',
    'name',
    'key',
    'slug',
    'kind',
    'domain',
    'role',
    'summary',
    'description',
    'details',
    'returnType',
  ]) {
    const v = item[key];
    if (typeof v === 'string') parts.push(v);
  }
  for (const key of ['values', 'relatedOperations', 'relatedTypes', 'frameworks', 'integrations']) {
    const v = item[key];
    if (Array.isArray(v)) parts.push(v.filter((x) => typeof x === 'string').join(' '));
  }
  return parts.join(' ').toLowerCase();
}

function displayName(item: Record<string, unknown>): string {
  return (
    (typeof item.name === 'string' && item.name) ||
    (typeof item.key === 'string' && item.key) ||
    (typeof item.id === 'string' && item.id) ||
    ''
  );
}

export interface SearchOptions {
  /** Restrict to specific categories. */
  categories?: KnowledgeCategory[];
  /** Max matches to return. */
  limit?: number;
}

/** Search a snapshot by keyword across all (or selected) categories. */
export function searchSnapshot(
  snapshot: KnowledgeSnapshot,
  query: string,
  opts: SearchOptions = {},
): KnowledgeMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const cats = opts.categories ?? (KNOWLEDGE_CATEGORIES as readonly KnowledgeCategory[]);
  const matches: KnowledgeMatch[] = [];

  for (const category of cats) {
    for (const item of snapshot[category] as Record<string, unknown>[]) {
      if (searchableText(item).includes(q)) {
        matches.push({ category, id: String(item.id), name: displayName(item), item });
        if (opts.limit && matches.length >= opts.limit) return matches;
      }
    }
  }
  return matches;
}

/** Find a single item across categories by exact (case-insensitive) name or id. */
export function findByName(
  snapshot: KnowledgeSnapshot,
  name: string,
): KnowledgeMatch | null {
  const target = name.trim().toLowerCase();
  for (const category of KNOWLEDGE_CATEGORIES as readonly KnowledgeCategory[]) {
    for (const item of snapshot[category] as Record<string, unknown>[]) {
      const n = typeof item.name === 'string' ? item.name.toLowerCase() : '';
      const id = typeof item.id === 'string' ? item.id.toLowerCase() : '';
      if (n === target || id === target) {
        return { category, id: String(item.id), name: displayName(item), item };
      }
    }
  }
  return null;
}
