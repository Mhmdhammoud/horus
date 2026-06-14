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

import type { HorusConfig, ResolvedEnvironment } from '@horus/core';
import { resolveEnvironment } from '@horus/core';
import { AxonHttpClient } from './axon/client.js';
import { AxonCodeProvider } from './axon/provider.js';
import type { CodeProvider } from './contract.js';
import { ElasticsearchClient } from './elasticsearch/client.js';
import { ElasticsearchLogsProvider } from './elasticsearch/provider.js';
import type { LogsProvider } from './elasticsearch/provider.js';
import { GrafanaClient } from './grafana/client.js';
import { GrafanaMetricsProvider } from './grafana/provider.js';
import type { MetricsProvider } from './grafana/provider.js';
import { MongoStateClient } from './mongodb/client.js';
import { MongoStateProvider } from './mongodb/provider.js';
import type { StateProvider } from './mongodb/provider.js';

// ---------------------------------------------------------------------------
// Environment-scoped builders (primary API, HOR-34)
// ---------------------------------------------------------------------------

/**
 * Return an Axon `CodeProvider` for the given resolved environment, or `null` when
 * no Axon connector is configured.
 */
export function codeForEnv(renv: ResolvedEnvironment): CodeProvider | null {
  const hostUrl = renv.connectors.axon?.hostUrl;
  if (!hostUrl) return null;
  return new AxonCodeProvider(new AxonHttpClient({ baseUrl: hostUrl }));
}

/**
 * Return an Elasticsearch `LogsProvider` for the given resolved environment, or
 * `null` when no (or incomplete) ES connector is configured.
 */
export function logsForEnv(renv: ResolvedEnvironment): LogsProvider | null {
  const es = renv.connectors.elasticsearch;
  if (!es || !es.url) return null;
  return new ElasticsearchLogsProvider(
    new ElasticsearchClient({ baseUrl: es.url, username: es.username, password: es.password }),
    { indexPattern: es.indexPattern },
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
    { defaultStep: 60 },
  );
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
      `No Axon connector configured for project "${renv.project}" / env "${renv.env}".`,
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
  return renv.connectors.axon?.hostUrl ?? '';
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
  return config.projects.map((p) => {
    const renv = resolveEnvironment(config, { project: p.name });
    const hostUrl = renv.connectors.axon?.hostUrl ?? '';
    const code = codeForEnv(renv);
    return {
      name: p.name,
      path: p.path,
      hostUrl,
      // repoProviders callers (repos.ts / reposHealth) always have Axon configured;
      // supply a no-op stub when missing so compilation is safe — health check will
      // return unreachable.
      code: code ?? new AxonCodeProvider(new AxonHttpClient({ baseUrl: '' })),
    };
  });
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
