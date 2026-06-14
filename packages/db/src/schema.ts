/**
 * Horus database schema — Postgres + Drizzle, NO pgvector (HOR-2).
 *
 * Tables: projects, repositories, investigations, evidence, findings, hypotheses,
 * incident_memory, queue_edges, provider_cache. Semantic search is delegated to Axon's
 * hybrid search, so there are no embedding columns. See architecture.md §2.6.
 */
import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  real,
  integer,
  timestamp,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

/** A project groups one or more repositories under investigation. */
export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Repositories Horus knows about. Horus owns this registry — `axon list` is unreliable. */
export const repositories = pgTable('repositories', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  path: text('path').notNull(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
  axonStatus: jsonb('axon_status'),
  stale: boolean('stale').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A single investigation run and its AI narrative. */
export const investigations = pgTable('investigations', {
  id: uuid('id').defaultRandom().primaryKey(),
  title: text('title').notNull(),
  incidentInput: jsonb('incident_input').notNull(),
  status: text('status').notNull().default('open'),
  summary: text('summary'),
  narrative: jsonb('narrative'),
  report: jsonb('report'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Typed, citable evidence gathered for an investigation. */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    source: text('source').notNull(), // ProviderKind: code|logs|metrics|state|queue|history
    kind: text('kind').notNull(), // EvidenceKind: log|metric|symbol|flow|commit|...
    title: text('title').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }), // event time, for timeline alignment
    relevance: real('relevance').notNull().default(0),
    payload: jsonb('payload'),
    links: jsonb('links'),
    provenance: jsonb('provenance'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('evidence_investigation_idx').on(t.investigationId)],
);

/** Ranked candidate root causes for an investigation. */
export const hypotheses = pgTable(
  'hypotheses',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    statement: text('statement').notNull(),
    score: real('score').notNull().default(0),
    supportingEvidence: uuid('supporting_evidence').array(),
    verdict: text('verdict'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('hypotheses_investigation_idx').on(t.investigationId)],
);

/**
 * The queue-boundary graph the stitcher synthesizes — the one thing Axon can't do.
 * Denormalized on purpose: one row pairs a producer with the worker that consumes the
 * same queue, so "which worker consumes this queue?" is a single lookup. Either side
 * may be null when only one end is discovered. Normalize later if needed.
 */
export const queueEdges = pgTable(
  'queue_edges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    queueName: text('queue_name').notNull(),
    producerSymbol: text('producer_symbol'),
    producerFile: text('producer_file'),
    workerSymbol: text('worker_symbol'),
    workerFile: text('worker_file'),
    source: text('source').notNull().default('stitcher'), // who synthesized this edge
    project: text('project'), // nullable for back-compat; set to the project label by the stitcher
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('queue_edges_queue_name_idx').on(t.queueName),
    index('queue_edges_source_project_idx').on(t.source, t.project),
  ],
);

/**
 * Response cache for expensive provider calls (Axon, Elasticsearch, Prometheus, Git).
 * Keyed by (provider, cache_key); `expires_at` drives TTL eviction.
 */
export const providerCache = pgTable(
  'provider_cache',
  {
    provider: text('provider').notNull(),
    cacheKey: text('cache_key').notNull(),
    payload: jsonb('payload'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.cacheKey] })],
);

/**
 * A discrete finding within an investigation — an observation or sub-conclusion.
 * Distinct from a `hypothesis` (a ranked candidate root cause): a finding is a fact
 * the engine asserts; a hypothesis is an explanation it is still weighing.
 */
export const findings = pgTable(
  'findings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id')
      .notNull()
      .references(() => investigations.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'observation' | 'anomaly' | 'correlation' | ...
    title: text('title').notNull(),
    detail: text('detail'),
    confidence: real('confidence').notNull().default(0),
    evidenceIds: uuid('evidence_ids').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('findings_investigation_idx').on(t.investigationId)],
);

/**
 * Memory of past incidents for pattern recognition (HOR-18). No pgvector — similarity
 * is matched on a normalized `signature` + `tags` + text rather than embeddings.
 * HOR-46: project column scopes recall to the originating repository.
 */
export const incidentMemory = pgTable(
  'incident_memory',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    investigationId: uuid('investigation_id').references(() => investigations.id, {
      onDelete: 'set null',
    }),
    project: text('project'), // repository/project scope for isolation (HOR-46)
    title: text('title').notNull(),
    summary: text('summary'),
    signature: text('signature'), // normalized incident signature, for recall
    tags: text('tags').array(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('incident_memory_signature_idx').on(t.signature),
    index('incident_memory_project_idx').on(t.project),
  ],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Repository = typeof repositories.$inferSelect;
export type NewRepository = typeof repositories.$inferInsert;
export type Investigation = typeof investigations.$inferSelect;
export type Evidence = typeof evidence.$inferSelect;
export type Hypothesis = typeof hypotheses.$inferSelect;
export type QueueEdge = typeof queueEdges.$inferSelect;
export type NewQueueEdge = typeof queueEdges.$inferInsert;
export type ProviderCacheRow = typeof providerCache.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type NewFinding = typeof findings.$inferInsert;
export type IncidentMemory = typeof incidentMemory.$inferSelect;
export type NewIncidentMemory = typeof incidentMemory.$inferInsert;
