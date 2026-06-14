export * as schema from './schema.js';
export {
  projects,
  repositories,
  investigations,
  evidence,
  findings,
  hypotheses,
  incidentMemory,
  queueEdges,
  providerCache,
} from './schema.js';
export type {
  Project,
  NewProject,
  Repository,
  NewRepository,
  Investigation,
  Evidence,
  Finding,
  NewFinding,
  Hypothesis,
  IncidentMemory,
  NewIncidentMemory,
  QueueEdge,
  NewQueueEdge,
  ProviderCacheRow,
} from './schema.js';
export { createDb, type HorusDb, type DbHandle } from './client.js';
export { replaceQueueEdges, listQueueEdges } from './queue.js';
export { runMigrations } from './migrate.js';
export { checkDatabase, EXPECTED_TABLES, type DbHealth } from './health.js';
