/**
 * Maison Safqa MCP knowledge-base importer (HOR-292).
 *
 * The first adapter that maps the prototype `knowledge-base.json` (GraphQL
 * operations, input/response types, enums, frontend patterns, domain concepts,
 * project profiles) into a Horus `KnowledgeSnapshot`. Imported items are tagged
 * `sourceType: 'imported'` with the KB's own `generatedAt` and a content hash as
 * provenance. Unknown/missing fields are skipped safely and reported as warnings,
 * never thrown.
 */
import { z } from 'zod';
import {
  KnowledgeSnapshotSchema,
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeSnapshot,
  type Provenance,
} from '../schema.js';

/** Loose view of the Maison Safqa KB — every category optional, extra keys kept. */
const looseField = z
  .object({
    name: z.string().optional(),
    type: z.string().optional(),
    nullable: z.boolean().optional(),
    description: z.string().optional(),
  })
  .passthrough();

const MaisonKbSchema = z
  .object({
    version: z.union([z.string(), z.number()]).optional(),
    generatedAt: z.string().optional(),
    operations: z.array(z.record(z.unknown())).optional(),
    inputTypes: z.array(z.record(z.unknown())).optional(),
    responseTypes: z.array(z.record(z.unknown())).optional(),
    enums: z.array(z.record(z.unknown())).optional(),
    frontendPatterns: z.array(z.record(z.unknown())).optional(),
    domainConcepts: z.array(z.record(z.unknown())).optional(),
    projectProfiles: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export type MaisonKnowledgeBase = z.infer<typeof MaisonKbSchema>;

export const MAISON_SAFQA_SOURCE = 'maison-safqa-mcp';

export interface ImportOptions {
  /** ISO timestamp for the produced snapshot (defaults to now). */
  now?: string;
  /** Content hash of the source file, recorded on every item's provenance. */
  contentHash?: string;
  /** Project name to scope the snapshot to. */
  project?: string;
}

export interface ImportResult {
  snapshot: KnowledgeSnapshot;
  /** Non-fatal issues: skipped malformed items, ignored unknown top-level keys. */
  warnings: string[];
  /** The detected KB schema version (string), if present. */
  kbVersion: string | null;
}

const KNOWN_KEYS = new Set([
  'version',
  'generatedAt',
  'operations',
  'inputTypes',
  'responseTypes',
  'enums',
  'frontendPatterns',
  'domainConcepts',
  'projectProfiles',
  'maisonSdl',
  'dataFlows',
]);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function mapFields(raw: unknown): { name: string; type: string; nullable?: boolean; description?: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { name: string; type: string; nullable?: boolean; description?: string }[] = [];
  for (const f of raw) {
    const parsed = looseField.safeParse(f);
    if (!parsed.success) continue;
    const name = str(parsed.data.name);
    const type = str(parsed.data.type);
    if (!name || !type) continue;
    out.push({
      name,
      type,
      nullable: typeof parsed.data.nullable === 'boolean' ? parsed.data.nullable : undefined,
      description: str(parsed.data.description),
    });
  }
  return out;
}

/**
 * Import a parsed Maison Safqa MCP knowledge-base into a `KnowledgeSnapshot`.
 * Pure: no file IO. Throws only when `raw` is not a KB-shaped object.
 */
export function importMaisonSafqaKnowledgeBase(
  raw: unknown,
  opts: ImportOptions = {},
): ImportResult {
  const parsed = MaisonKbSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Not a Maison Safqa knowledge-base: ${parsed.error.issues[0]?.message ?? 'invalid shape'}`);
  }
  const kb = parsed.data;
  const warnings: string[] = [];

  const kbVersion = kb.version != null ? String(kb.version) : null;
  if (!kbVersion) {
    warnings.push('knowledge-base is missing a `version` field; importing without a schema version.');
  }

  // Report (don't fail on) unmapped top-level keys.
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`ignored unknown top-level key: \`${key}\``);
  }
  if (typeof (raw as Record<string, unknown>).maisonSdl === 'string') {
    warnings.push('`maisonSdl` is not mapped to a knowledge entity (kept out of the snapshot).');
  }

  const baseProv: Provenance = {
    sourceType: 'imported',
    repo: opts.project,
    generatedAt: kb.generatedAt,
    contentHash: opts.contentHash,
  };
  const prov = (extra: Partial<Provenance> = {}): Provenance => ({ ...baseProv, ...extra });
  const scope = opts.project ? { project: opts.project } : undefined;

  const skip = (cat: string, why: string) => warnings.push(`skipped ${cat}: ${why}`);

  // ── operations ──
  const operations = (kb.operations ?? []).flatMap((o) => {
    const name = str(o.name);
    if (!name) {
      skip('operation', 'missing `name`');
      return [];
    }
    const auth = o.auth && typeof o.auth === 'object' ? (o.auth as Record<string, unknown>) : undefined;
    return [
      {
        id: `operation:${name}`,
        scope,
        provenance: prov({ filePath: str(o.resolverFile) }),
        name,
        kind: str(o.kind) ?? 'operation',
        protocol: 'graphql',
        domain: str(o.domain),
        description: str(o.description),
        resolverFile: str(o.resolverFile),
        auth: auth
          ? {
              required: auth.required === true,
              roles: strArray(auth.roles),
              notes: str(auth.notes),
            }
          : undefined,
        args: mapFields(o.args),
        returnType: str(o.returnType),
      },
    ];
  });

  // ── types (input + response) ──
  const mapType = (kind: string) => (t: Record<string, unknown>) => {
    const name = str(t.name);
    if (!name) {
      skip(`${kind} type`, 'missing `name`');
      return [];
    }
    return [
      {
        id: `type:${name}`,
        scope,
        provenance: prov({ filePath: str(t.sourceFile) }),
        name,
        kind: str(t.kind) ?? kind,
        fields: mapFields(t.fields),
        sourceFile: str(t.sourceFile),
        description: str(t.description),
      },
    ];
  };
  const types = [
    ...(kb.inputTypes ?? []).flatMap(mapType('input')),
    ...(kb.responseTypes ?? []).flatMap(mapType('response')),
  ];

  // ── enums ──
  const enums = (kb.enums ?? []).flatMap((e) => {
    const name = str(e.name);
    if (!name) {
      skip('enum', 'missing `name`');
      return [];
    }
    return [
      {
        id: `enum:${name}`,
        scope,
        provenance: prov(),
        name,
        values: strArray(e.values),
        description: str(e.description),
      },
    ];
  });

  // ── frontend patterns ──
  const frontendPatterns = (kb.frontendPatterns ?? []).flatMap((p) => {
    const name = str(p.name);
    if (!name) {
      skip('frontend pattern', 'missing `name`');
      return [];
    }
    const kind = str(p.kind) ?? 'pattern';
    return [
      {
        id: `fe:${kind}:${name}`,
        scope,
        provenance: prov({ filePath: str(p.filePath) }),
        kind,
        name,
        filePath: str(p.filePath),
        description: str(p.description),
      },
    ];
  });

  // ── domain concepts ──
  const domainConcepts = (kb.domainConcepts ?? []).flatMap((c) => {
    const name = str(c.name);
    if (!name) {
      skip('domain concept', 'missing `name`');
      return [];
    }
    const slug = str(c.slug);
    return [
      {
        id: `concept:${slug ?? name}`,
        scope,
        provenance: prov(),
        name,
        slug,
        summary: str(c.summary),
        details: str(c.details),
        relatedOperations: strArray(c.relatedOperations),
        relatedTypes: strArray(c.relatedTypes),
      },
    ];
  });

  // ── project profiles → repository profiles ──
  const repositories = (kb.projectProfiles ?? []).flatMap((p) => {
    const key = str(p.key) ?? str(p.name);
    if (!key) {
      skip('project profile', 'missing `key`/`name`');
      return [];
    }
    return [
      {
        id: `repo:${key}`,
        scope,
        provenance: prov(),
        key,
        name: str(p.name) ?? key,
        path: str(p.path),
        role: str(p.role),
        summary: str(p.summary),
        frameworks: strArray(p.frameworks),
        languages: strArray(p.languages),
        stateManagement: strArray(p.stateManagement),
        auth: strArray(p.auth),
        dataSources: strArray(p.dataSources),
        mainScripts: strArray(p.mainScripts),
        integrations: strArray(p.integrations),
        deploymentNotes: strArray(p.deploymentNotes),
        importantDirectories: strArray(p.importantDirectories),
      },
    ];
  });

  // Validate the assembled snapshot against the canonical schema.
  const snapshot = KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: opts.now ?? new Date().toISOString(),
    project: opts.project,
    repositories,
    operations,
    types,
    enums,
    domainConcepts,
    frontendPatterns,
  });

  return { snapshot, warnings, kbVersion };
}
