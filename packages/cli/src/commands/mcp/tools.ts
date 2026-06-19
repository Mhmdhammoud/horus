/**
 * Horus MCP knowledge tools (HOR-295).
 *
 * A transport-agnostic tool layer over the local `.horus/index/` project-knowledge
 * snapshot — the same query layer behind the `horus knowledge` CLI. Each tool is a
 * pure function of (args, repo root); the MCP server (server.ts) is a thin adapter.
 * Every result carries provenance + staleness so agents can trust/age the answer.
 * Offline / local-only — never touches Horus Cloud.
 */
import { z, type ZodRawShape } from 'zod';
import { getHeadSha, isWorkingTreeDirty } from '@horus/core';
import {
  createJsonKnowledgeStore,
  searchSnapshot,
  type KnowledgeSnapshot,
  type KnowledgeManifest,
} from '@horus/knowledge';

export interface Staleness {
  indexedSha: string | null;
  currentSha: string | null;
  stale: boolean;
  dirty: boolean;
}

export interface ToolResult {
  ok: boolean;
  /** One-line human summary. */
  summary: string;
  /** Structured payload (includes staleness + provenance-bearing items). */
  data?: unknown;
}

export interface KnowledgeTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (args: Record<string, unknown>, root: string) => ToolResult;
}

interface Ctx {
  snapshot: KnowledgeSnapshot;
  manifest: KnowledgeManifest | null;
  staleness: Staleness;
}

function staleness(root: string, manifest: KnowledgeManifest | null): Staleness {
  const indexedSha = manifest?.git?.sha ?? null;
  const currentSha = getHeadSha(root);
  return {
    indexedSha,
    currentSha,
    stale: Boolean(indexedSha && currentSha && indexedSha !== currentSha),
    dirty: isWorkingTreeDirty(root) === true,
  };
}

function load(root: string): Ctx | null {
  const store = createJsonKnowledgeStore(root);
  if (!store.exists()) return null;
  const snapshot = store.readSnapshot();
  if (!snapshot) return null;
  const manifest = store.readManifest();
  return { snapshot, manifest, staleness: staleness(root, manifest) };
}

const NO_INDEX: ToolResult = {
  ok: false,
  summary: 'No local project-knowledge index found. Build it with `horus index` (or import one).',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const matchName = (item: Record<string, unknown>, needle: string) =>
  str(item.name).toLowerCase().includes(needle) ||
  str(item.subject).toLowerCase().includes(needle) ||
  str(item.slug).toLowerCase().includes(needle) ||
  str(item.id).toLowerCase().includes(needle);

/** Build the Horus knowledge MCP tools (bound to a repo root at call time). */
export const KNOWLEDGE_TOOLS: KnowledgeTool[] = [
  {
    name: 'get_knowledge_status',
    description:
      'Check whether Horus has a fresh local project-knowledge index for this repo. Call this FIRST: it reports schema version, the indexed commit, item counts, and staleness (whether the repo moved past the index or has uncommitted changes).',
    inputSchema: {},
    handler: (_args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const m = ctx.manifest;
      return {
        ok: true,
        summary: `Index for ${m?.project ?? 'project'} @ ${(ctx.staleness.indexedSha ?? '—').slice(0, 8)}${ctx.staleness.stale ? ' (STALE)' : ''}`,
        data: {
          project: m?.project,
          schemaVersion: m?.schemaVersion,
          generatedAt: m?.generatedAt,
          generator: m?.generator,
          branch: m?.git?.branch,
          counts: m?.counts,
          staleness: ctx.staleness,
        },
      };
    },
  },
  {
    name: 'get_project_landscape',
    description:
      'Get the project landscape: each repository/codebase with its role, frameworks, languages, data sources, auth, and integrations — so you understand the system before reading files.',
    inputSchema: {},
    handler: (_args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      return {
        ok: true,
        summary: `${ctx.snapshot.repositories.length} repository profile(s).`,
        data: { repositories: ctx.snapshot.repositories, staleness: ctx.staleness },
      };
    },
  },
  {
    name: 'search_project_knowledge',
    description:
      'Ask Horus FIRST, before grepping the repo: keyword-search the indexed operations, types, enums, domain concepts, frontend patterns, and runtime components. Returns items with provenance (file/source) and staleness.',
    inputSchema: { query: z.string().describe('keyword or phrase'), limit: z.number().int().optional() },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const matches = searchSnapshot(ctx.snapshot, str(args.query), {
        limit: typeof args.limit === 'number' ? args.limit : 25,
      });
      return {
        ok: true,
        summary: `${matches.length} match(es) for "${str(args.query)}".`,
        data: {
          matches: matches.map((m) => ({ category: m.category, id: m.id, name: m.name, provenance: m.item.provenance })),
          staleness: ctx.staleness,
        },
      };
    },
  },
  {
    name: 'ask_project_question',
    description:
      'Answer a natural-language project question from indexed knowledge ONLY (grounded, no guessing): returns the most relevant indexed items with provenance. Prefer this over reading the whole repo for "what owns X / which operation handles Y" questions.',
    inputSchema: { question: z.string().describe('natural-language question') },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const q = str(args.question);
      const terms = [q, ...q.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 4)];
      const seen = new Set<string>();
      const hits: { category: string; id: string; name: string; provenance: unknown }[] = [];
      for (const term of terms) {
        for (const m of searchSnapshot(ctx.snapshot, term, { limit: 10 })) {
          if (!seen.has(m.id)) {
            seen.add(m.id);
            hits.push({ category: m.category, id: m.id, name: m.name, provenance: m.item.provenance });
          }
        }
        if (hits.length >= 8) break;
      }
      return {
        ok: true,
        summary: hits.length ? `Grounded in ${hits.length} indexed item(s).` : 'No indexed knowledge matched.',
        data: { question: q, grounded: true, matches: hits.slice(0, 8), staleness: ctx.staleness },
      };
    },
  },
  {
    name: 'get_contract',
    description:
      'Get the exact API contract for a name — operations (args, return type, auth), types (fields), enums (valid values), and auth rules — verbatim from the index. Use this instead of guessing field/enum values.',
    inputSchema: { name: z.string().describe('operation/type/enum/rule name') },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const needle = str(args.name).toLowerCase();
      const s = ctx.snapshot;
      const operations = (s.operations as Record<string, unknown>[]).filter((i) => matchName(i, needle));
      const types = (s.types as Record<string, unknown>[]).filter((i) => matchName(i, needle));
      const enums = (s.enums as Record<string, unknown>[]).filter((i) => matchName(i, needle));
      const authRules = (s.authRules as Record<string, unknown>[]).filter((i) => matchName(i, needle));
      const total = operations.length + types.length + enums.length + authRules.length;
      return {
        ok: true,
        summary: `${total} contract item(s) matching "${str(args.name)}".`,
        data: { operations, types, enums, authRules, staleness: ctx.staleness },
      };
    },
  },
  {
    name: 'get_domain_concept',
    description:
      'Get a domain concept / business rule by name: its summary, details, and the operations + types it relates to. Use this to understand a feature before changing it.',
    inputSchema: { name: z.string().describe('concept name or slug') },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const needle = str(args.name).toLowerCase();
      const concepts = (ctx.snapshot.domainConcepts as Record<string, unknown>[]).filter((i) => matchName(i, needle));
      return {
        ok: true,
        summary: `${concepts.length} domain concept(s) matching "${str(args.name)}".`,
        data: { concepts, staleness: ctx.staleness },
      };
    },
  },
  {
    name: 'search_frontend_pattern',
    description:
      'Find an existing frontend pattern (hook, store, provider, server function, component) before writing a new one. Returns matches with their file paths.',
    inputSchema: { query: z.string().describe('keyword (e.g. hook name or purpose)') },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const needle = str(args.query).toLowerCase();
      const patterns = (ctx.snapshot.frontendPatterns as Record<string, unknown>[]).filter(
        (i) => matchName(i, needle) || str(i.kind).toLowerCase().includes(needle),
      );
      return {
        ok: true,
        summary: `${patterns.length} frontend pattern(s) matching "${str(args.query)}".`,
        data: { patterns, staleness: ctx.staleness },
      };
    },
  },
  {
    name: 'get_runtime_component_map',
    description:
      'Get the runtime component map: services, workers, queues, cron jobs, and external integrations the project runs — so you know which worker/queue/service handles a job.',
    inputSchema: {},
    handler: (_args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      return {
        ok: true,
        summary: `${ctx.snapshot.runtimeComponents.length} runtime component(s), ${ctx.snapshot.externalIntegrations.length} integration(s).`,
        data: {
          runtimeComponents: ctx.snapshot.runtimeComponents,
          externalIntegrations: ctx.snapshot.externalIntegrations,
          staleness: ctx.staleness,
        },
      };
    },
  },
  {
    name: 'trace_data_flow',
    description:
      'Trace known links for a topic: a domain concept → its operations/types, an operation ← the concepts that use it, or a named data flow → its steps. Use to follow how data moves across frontend/backend/runtime.',
    inputSchema: { query: z.string().describe('concept, operation, or data-flow name') },
    handler: (args, root) => {
      const ctx = load(root);
      if (!ctx) return NO_INDEX;
      const q = str(args.query).toLowerCase();
      const s = ctx.snapshot;
      const find = (arr: Record<string, unknown>[]) =>
        arr.find((i) => str(i.name).toLowerCase().includes(q) || str(i.slug).toLowerCase().includes(q));

      const concept = find(s.domainConcepts as Record<string, unknown>[]);
      if (concept) {
        return {
          ok: true,
          summary: `Concept "${concept.name}" → operations/types.`,
          data: {
            kind: 'concept',
            concept,
            relatedOperations: concept.relatedOperations ?? [],
            relatedTypes: concept.relatedTypes ?? [],
            staleness: ctx.staleness,
          },
        };
      }
      const op = find(s.operations as Record<string, unknown>[]);
      if (op) {
        const usedBy = (s.domainConcepts as Record<string, unknown>[])
          .filter((c) => Array.isArray(c.relatedOperations) && (c.relatedOperations as string[]).includes(str(op.name)))
          .map((c) => c.name);
        return {
          ok: true,
          summary: `Operation "${op.name}" → returnType, ← concepts.`,
          data: { kind: 'operation', operation: op, usedByConcepts: usedBy, staleness: ctx.staleness },
        };
      }
      const flow = find(s.dataFlows as Record<string, unknown>[]);
      if (flow) {
        return { ok: true, summary: `Data flow "${flow.name}".`, data: { kind: 'dataFlow', flow, staleness: ctx.staleness } };
      }
      return { ok: true, summary: `Nothing to trace for "${str(args.query)}".`, data: { matches: [], staleness: ctx.staleness } };
    },
  },
];
