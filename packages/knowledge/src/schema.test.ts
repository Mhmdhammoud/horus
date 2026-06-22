import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KnowledgeSnapshotSchema,
  KnowledgeManifestSchema,
  ProvenanceSchema,
  itemStatus,
  KNOWLEDGE_SCHEMA_VERSION,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeSnapshot,
} from './schema.js';
import { createJsonKnowledgeStore } from './store.js';
import { knowledgePath } from './layout.js';
import { existsSync } from 'node:fs';

const NOW = '2026-06-19T14:00:00.000Z';

type SnapshotInput = z.input<typeof KnowledgeSnapshotSchema>;

function emptySnapshot(over: Partial<SnapshotInput> = {}): KnowledgeSnapshot {
  return KnowledgeSnapshotSchema.parse({
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    generatedAt: NOW,
    project: 'maison',
    ...over,
  });
}

describe('KnowledgeSnapshotSchema', () => {
  it('parses a minimal snapshot and defaults every category to []', () => {
    const snap = emptySnapshot();
    for (const cat of KNOWLEDGE_CATEGORIES) {
      expect(snap[cat]).toEqual([]);
    }
    expect(snap.schemaVersion).toBe(1);
  });

  it('rejects an unknown schema version', () => {
    expect(() =>
      KnowledgeSnapshotSchema.parse({ schemaVersion: 999, generatedAt: NOW }),
    ).toThrow();
  });

  it('requires provenance on every item and a stable id', () => {
    expect(() =>
      KnowledgeSnapshotSchema.parse({
        schemaVersion: 1,
        generatedAt: NOW,
        operations: [{ name: 'createSale', kind: 'mutation' }], // no id / provenance
      }),
    ).toThrow();
  });

  it('represents the Maison Safqa prototype shapes (operations/types/enums/concepts/profiles/patterns)', () => {
    const prov = { sourceType: 'parsed' as const, repo: 'maison-safqa' };
    const snap = emptySnapshot({
      repositories: [
        {
          id: 'repo:maison-safqa',
          provenance: prov,
          key: 'maison-safqa',
          name: 'maison-safqa',
          role: 'core backend',
          frameworks: ['TypeGraphQL', 'Express'],
          languages: ['TypeScript'],
          integrations: ['Shopify', 'Clerk'],
        },
      ],
      operations: [
        {
          id: 'operation:createBrandApiKey',
          provenance: { ...prov, filePath: 'src/resolvers/api-key.resolver.ts' },
          name: 'createBrandApiKey',
          kind: 'mutation',
          domain: 'api-keys',
          auth: { required: false, roles: [], notes: 'Public' },
          args: [{ name: 'input', type: 'CreateApiKeyInput', nullable: false }],
          returnType: 'CreateApiKeyResponse',
        },
      ],
      types: [
        {
          id: 'type:CreateApiKeyInput',
          provenance: prov,
          name: 'CreateApiKeyInput',
          kind: 'input',
          fields: [{ name: 'brand_id', type: 'string', nullable: false }],
          sourceFile: 'src/inputs/api-key.inputs.ts',
        },
      ],
      enums: [
        {
          id: 'enum:ScheduledEvents',
          provenance: { ...prov, sourceType: 'parsed' },
          name: 'ScheduledEvents',
          values: ['SEED_INSTA', 'SYNC_EMODA_PRODUCTS'],
        },
      ],
      domainConcepts: [
        {
          id: 'concept:flash-sale',
          provenance: { sourceType: 'inferred', confidence: 'medium' },
          name: 'Flash Sale Lifecycle',
          slug: 'flash-sale',
          relatedOperations: ['createSale', 'editSale'],
          relatedTypes: ['CreateSaleInput'],
        },
      ],
      frontendPatterns: [
        {
          id: 'fe:useAbandonmentTracking',
          provenance: { ...prov, filePath: 'src/hooks/useAbandonmentTracking.ts' },
          kind: 'hook',
          name: 'useAbandonmentTracking',
        },
      ],
    });

    expect(snap.operations[0]?.name).toBe('createBrandApiKey');
    expect(snap.operations[0]?.protocol).toBe('graphql'); // defaulted
    expect(snap.types[0]?.fields[0]?.name).toBe('brand_id');
    expect(snap.enums[0]?.values).toContain('SEED_INSTA');
    expect(snap.repositories[0]?.frameworks).toContain('TypeGraphQL');
  });
});

describe('ProvenanceSchema + itemStatus', () => {
  it('requires a sourceType', () => {
    expect(() => ProvenanceSchema.parse({})).toThrow();
    expect(ProvenanceSchema.parse({ sourceType: 'manual' }).sourceType).toBe('manual');
  });

  it('flags a parsed item as stale when its content hash changed', () => {
    const p = ProvenanceSchema.parse({ sourceType: 'parsed', contentHash: 'abc' });
    expect(itemStatus(p, { contentHash: 'abc' })).toBe('current');
    expect(itemStatus(p, { contentHash: 'xyz' })).toBe('stale');
  });

  it('treats manual/inferred items as unknown (not hash-tied)', () => {
    const p = ProvenanceSchema.parse({ sourceType: 'manual', contentHash: 'abc' });
    expect(itemStatus(p, { contentHash: 'xyz' })).toBe('unknown');
  });

  it('returns unknown when there is nothing to compare', () => {
    const p = ProvenanceSchema.parse({ sourceType: 'parsed' });
    expect(itemStatus(p, {})).toBe('unknown');
  });
});

describe('createJsonKnowledgeStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function tmpRoot() {
    const d = mkdtempSync(join(tmpdir(), 'horus-knowledge-'));
    dirs.push(d);
    return d;
  }

  it('round-trips a snapshot and writes a manifest + derived views', () => {
    const root = tmpRoot();
    const store = createJsonKnowledgeStore(root);
    expect(store.exists()).toBe(false);

    const snap = emptySnapshot({
      enums: [
        {
          id: 'enum:Role',
          provenance: { sourceType: 'parsed' },
          name: 'Role',
          values: ['ADMIN', 'USER'],
        },
      ],
    });
    const manifest = store.write(snap, {
      generator: { tool: 'maison-safqa-import', version: '0.1.0' },
      repositories: [{ name: 'maison-safqa', headSha: 'deadbeef' }],
      sourceIntelligence: { tool: 'source', version: '1.0.7' },
    });

    expect(store.exists()).toBe(true);
    expect(manifest.counts.enums).toBe(1);
    expect(manifest.generator.tool).toBe('maison-safqa-import');

    // Manifest + canonical + derived view files all exist.
    expect(existsSync(knowledgePath(root, 'manifest'))).toBe(true);
    expect(existsSync(knowledgePath(root, 'contracts'))).toBe(true);
    expect(existsSync(knowledgePath(root, 'runtimeMap'))).toBe(true);

    const read = store.readSnapshot();
    expect(read?.enums[0]?.name).toBe('Role');
    const readManifest = store.readManifest();
    expect(readManifest?.sourceIntelligence?.tool).toBe('source');
    expect(KnowledgeManifestSchema.parse(readManifest)).toBeTruthy();
  });

  it('refuses to write an invalid snapshot (no half-written files)', () => {
    const root = tmpRoot();
    const store = createJsonKnowledgeStore(root);
    expect(() =>
      // @ts-expect-error — intentionally invalid
      store.write({ schemaVersion: 1 }),
    ).toThrow();
    expect(store.exists()).toBe(false);
  });
});
