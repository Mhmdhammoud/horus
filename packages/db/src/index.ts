export * as schema from './schema.js';
export {
  repositories,
  investigations,
  evidence,
  hypotheses,
  queueEdges,
  providerCache,
} from './schema.js';
export type {
  Repository,
  NewRepository,
  Investigation,
  Evidence,
  Hypothesis,
  QueueEdge,
  NewQueueEdge,
  ProviderCacheRow,
} from './schema.js';
export { createDb, type HorusDb, type DbHandle } from './client.js';
export { runMigrations } from './migrate.js';
export { checkDatabase, EXPECTED_TABLES, type DbHealth } from './health.js';
