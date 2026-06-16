/**
 * ConnectorFactory — wires a `HorusConfig` or a `ResolvedEnvironment` into live
 * provider instances.
 *
 * HOR-34: The primary API is now environment-scoped (`codeForEnv`, `logsForEnv`,
 * `metricsForEnv`). The old global helpers (`codeForRepo`, `logsProviderFromConfig`,
 * `metricsProviderFromConfig`, `repoProviders`, `createConnectors`,
 * `axonHostUrlForRepo`) are kept as thin compat wrappers so existing commands compile
 * unchanged.
 */

import type { HorusConfig, ResolvedEnvironment, ResolvedElasticsearchFields } from '@horus/core';
import { resolveEnvironment } from '@horus/core';
import { SourceHttpClient, SourceCodeProvider } from './axon/source-boundary.js';
import type { CodeProvider } from './contract.js';
import { ElasticsearchClient } from './elasticsearch/client.js';
import { ElasticsearchLogsProvider } from './elasticsearch/provider.js';
import type { LogsProvider } from './elasticsearch/provider.js';
import {
  type ElasticsearchFieldMapping,
  MERITT_FIELD_MAPPING,
  ECS_FIELD_MAPPING,
} from './elasticsearch/normalize.js';
import { GrafanaClient } from './grafana/client.js';
import { GrafanaMetricsProvider } from './grafana/provider.js';
import type { MetricsProvider } from './grafana/provider.js';
import { MongoStateClient } from './mongodb/client.js';
import { MongoStateProvider } from './mongodb/provider.js';
import type { StateProvider } from './mongodb/provider.js';
import { BullMQRedisClient } from './bullmq/client.js';
import { BullMQRuntimeProvider } from './bullmq/provider.js';
import type { QueueRuntimeProvider } from './bullmq/provider.js';

// ---------------------------------------------------------------------------
// Environment-scoped builders (primary API, HOR-34)
// ---------------------------------------------------------------------------

/**
 * Return a source `CodeProvider` for the given resolved environment, or `null` when
 * no source connector is configured.
 */
export function codeForEnv(renv: ResolvedEnvironment): CodeProvider | null {
  const repo = renv.repositories[0];
  const hostUrl = repo?.sourceHostUrl ?? repo?.axonHostUrl;
  if (!hostUrl) return null;
  return new SourceCodeProvider(new SourceHttpClient({ baseUrl: hostUrl }));
}

/**
 * Return an Elasticsearch `LogsProvider` for the given resolved environment, or
 * `null` when no (or incomplete) ES connector is configured.
 */
function applyFieldOverrides(
  base: ElasticsearchFieldMapping,
  overrides: ResolvedElasticsearchFields,
): ElasticsearchFieldMapping {
  return {
    ...base,
    ...(overrides.timestamp !== undefined ? { timestampField: overrides.timestamp } : {}),
    ...(overrides.level !== undefined ? { levelField: overrides.level } : {}),
    ...(overrides.levelFormat !== undefined ? { levelFormat: overrides.levelFormat } : {}),
    ...(overrides.service !== undefined ? { serviceField: overrides.service } : {}),
    ...(overrides.serviceKeyword !== undefined ? { serviceKeyword: overrides.serviceKeyword } : {}),
    ...(overrides.message !== undefined ? { messageField: overrides.message } : {}),
    ...(overrides.messageFallback !== undefined ? { messageFallbackField: overrides.messageFallback } : {}),
    ...(overrides.traceId !== undefined ? { traceIdField: overrides.traceId } : {}),
    ...(overrides.requestId !== undefined ? { requestIdField: overrides.requestId } : {}),
    ...(overrides.eventCode !== undefined ? { eventCodeField: overrides.eventCode } : {}),
    ...(overrides.eventCodeKeyword !== undefined ? { eventCodeKeyword: overrides.eventCodeKeyword } : {}),
  };
}

export function logsForEnv(renv: ResolvedEnvironment): LogsProvider | null {
  const es = renv.connectors.elasticsearch;
  if (!es || !es.url) return null;
  const base = es.preset === 'ecs' ? ECS_FIELD_MAPPING : MERITT_FIELD_MAPPING;
  const fieldMapping = es.fields !== undefined ? applyFieldOverrides(base, es.fields) : base;
  return new ElasticsearchLogsProvider(
    new ElasticsearchClient({ baseUrl: es.url, username: es.username, password: es.password }),
    { indexPattern: es.indexPattern, fieldMapping },
  );
}

/**
 * Return a Grafana `MetricsProvider` for the given resolved environment, or `null`
 * when no (or incomplete) Grafana connector is configured.
 */
export function metricsForEnv(renv: ResolvedEnvironment): MetricsProvider | null {
  const g = renv.connectors.grafana;
  if (!g || !g.url) return null;
  return new GrafanaMetricsProvider(
    new GrafanaClient({ baseUrl: g.url, username: g.username, password: g.password }),
    { defaultStep: 60, dashboardUids: g.dashboards },
  );
}

/**
 * Return a BullMQ `QueueRuntimeProvider` for the given resolved environment, or
 * `null` when no Redis connector is configured (no URL).
 */
export function queueForEnv(renv: ResolvedEnvironment): QueueRuntimeProvider | null {
  const r = renv.connectors.redis;
  if (!r?.url) return null;
  return new BullMQRuntimeProvider(new BullMQRedisClient({ url: r.url }));
}

/**
 * Return a MongoDB `StateProvider` for the given resolved environment, or `null`
 * when no Mongo connector is configured (no URL — e.g. a different cluster whose
 * URL env var is unset). Read-only, allowlisted collections only.
 */
export function mongoForEnv(renv: ResolvedEnvironment): StateProvider | null {
  const m = renv.connectors.mongodb;
  if (!m || !m.url || !m.database) return null;
  return new MongoStateProvider(
    new MongoStateClient({
      url: m.url,
      database: m.database,
      allowlist: m.collections,
    }),
    { database: m.database, collections: m.collections, staleHours: 24 },
  );
}

// ---------------------------------------------------------------------------
// Legacy Connectors bundle type
// ---------------------------------------------------------------------------

export interface Connectors {
  code: CodeProvider;
}

// ---------------------------------------------------------------------------
// Compat wrappers — keep existing CLI commands compiling unchanged (HOR-34)
// ---------------------------------------------------------------------------

/**
 * Return a `CodeProvider` wired to the Axon host for a specific project (or the
 * default/single project when `repoName` is omitted). `repoName` maps 1:1 to a
 * project name via `resolveEnvironment`.
 *
 * Throws when no Axon connector is configured for the resolved environment.
 */
export function codeForRepo(config: HorusConfig, repoName?: string): CodeProvider {
  const renv = resolveEnvironment(config, { project: repoName });
  const c = codeForEnv(renv);
  if (!c) {
    throw new Error(
      `No source-intelligence connector configured for project "${renv.project}" / env "${renv.env}".`,
    );
  }
  return c;
}

/**
 * Resolve the Axon host URL for a named project (compat: was axonHostUrlForRepo).
 * Falls back to empty string when no Axon connector is configured.
 */
export function axonHostUrlForRepo(config: HorusConfig, repoName?: string): string {
  const renv = resolveEnvironment(config, { project: repoName });
  const repo = renv.repositories[0];
  return repo?.sourceHostUrl ?? repo?.axonHostUrl ?? '';
}

/** Horus-facing delegate for axonHostUrlForRepo (HOR-136). */
export function sourceHostUrlForRepo(config: HorusConfig, repoName?: string): string {
  return axonHostUrlForRepo(config, repoName);
}

/**
 * Build and return a Connectors bundle for the default (or single) project/env.
 * Throws when no Axon connector is present.
 */
export function createConnectors(config: HorusConfig): Connectors {
  return { code: codeForRepo(config) };
}

/** A fully-resolved, live-wired descriptor for a single configured project. */
export interface RepoProvider {
  name: string;
  path: string;
  hostUrl: string;
  code: CodeProvider;
}

/**
 * Build a `RepoProvider` for every project in the config. Each provider is pointed
 * at the project's resolved Axon host.
 */
export function repoProviders(config: HorusConfig): RepoProvider[] {
  const out: RepoProvider[] = [];
  for (const p of config.projects) {
    const renv = resolveEnvironment(config, { project: p.name });
    for (const r of renv.repositories) {
      const hostUrl = r.axonHostUrl ?? '';
      out.push({
        name: r.name,
        path: r.path,
        hostUrl,
        // A missing Axon host yields a stub that reports unreachable on health().
        code: new SourceCodeProvider(new SourceHttpClient({ baseUrl: hostUrl })),
      });
    }
  }
  return out;
}

/**
 * Build a `LogsProvider` wired to Elasticsearch for the default project/env.
 * No longer reads global env vars directly — secrets come from resolveEnvironment.
 * Returns `null` when Elasticsearch is not configured or the URL is missing.
 */
export function logsProviderFromConfig(config: HorusConfig): LogsProvider | null {
  return logsForEnv(resolveEnvironment(config));
}

/**
 * Build a `MetricsProvider` backed by Grafana for the default project/env.
 * No longer reads global env vars directly — secrets come from resolveEnvironment.
 * Returns `null` when Grafana is not configured or the URL is missing.
 */
export function metricsProviderFromConfig(config: HorusConfig): MetricsProvider | null {
  return metricsForEnv(resolveEnvironment(config));
}
