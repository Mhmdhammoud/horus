/**
 * ConnectorFactory — wires a validated `HorusConfig` into live provider instances.
 *
 * v0 ships only the Axon-backed code provider; runtime providers (ES, Prometheus,
 * Redis, BullMQ, Git) join the `Connectors` bundle in HOR-5.
 *
 * HOR-28 adds per-repo helpers so investigations can traverse repo boundaries
 * without the caller needing to know which host holds the answer.
 */

import type { HorusConfig } from '@horus/core';
import { AxonHttpClient } from './axon/client.js';
import { AxonCodeProvider } from './axon/provider.js';
import type { CodeProvider } from './contract.js';
import { ElasticsearchClient } from './elasticsearch/client.js';
import { ElasticsearchLogsProvider } from './elasticsearch/provider.js';
import type { LogsProvider } from './elasticsearch/provider.js';
import { GrafanaClient } from './grafana/client.js';
import { GrafanaMetricsProvider } from './grafana/provider.js';
import type { MetricsProvider } from './grafana/provider.js';

export interface Connectors {
  code: CodeProvider;
}

export function createConnectors(config: HorusConfig): Connectors {
  return {
    code: new AxonCodeProvider(new AxonHttpClient({ baseUrl: config.axon.hostUrl })),
  };
}

/**
 * Resolve the Axon host URL for a named repo. Falls back to the global default
 * when the repo has no per-repo `axonHostUrl`, or when no `repoName` is given.
 */
export function axonHostUrlForRepo(config: HorusConfig, repoName?: string): string {
  if (repoName !== undefined) {
    const repo = config.repos.find((r) => r.name === repoName);
    if (repo !== undefined) {
      return repo.axonHostUrl ?? config.axon.hostUrl;
    }
  }
  return config.axon.hostUrl;
}

/**
 * Return a `CodeProvider` wired to the Axon host for a specific repo (or the
 * global default when `repoName` is omitted / not found).
 */
export function codeForRepo(config: HorusConfig, repoName?: string): CodeProvider {
  return new AxonCodeProvider(
    new AxonHttpClient({ baseUrl: axonHostUrlForRepo(config, repoName) }),
  );
}

/** A fully-resolved, live-wired descriptor for a single configured repository. */
export interface RepoProvider {
  name: string;
  path: string;
  hostUrl: string;
  code: CodeProvider;
}

/**
 * Build a `LogsProvider` wired to Elasticsearch, resolving credentials from config
 * then env vars. Returns null when no ES URL is available.
 */
export function logsProviderFromConfig(config: HorusConfig): LogsProvider | null {
  const esCfg = config.providers.elasticsearch;
  const url = esCfg?.url ?? process.env['ES_URL'];
  if (!url) return null;

  const username = esCfg?.username ?? process.env['ES_USERNAME'];
  const password = esCfg?.password ?? process.env['ES_PASSWORD'];
  const indexPattern = esCfg?.indexPattern ?? process.env['ES_INDEX_PATTERN'] ?? '*';

  return new ElasticsearchLogsProvider(
    new ElasticsearchClient({ baseUrl: url, username, password }),
    { indexPattern },
  );
}

/**
 * Build a `MetricsProvider` backed by Grafana (datasource proxy for Prometheus).
 * Resolves credentials from config then env vars.
 * Returns null when GRAFANA_URL is not available.
 */
export function metricsProviderFromConfig(config: HorusConfig): MetricsProvider | null {
  const grafanaCfg = config.providers.grafana;
  const url = grafanaCfg?.url ?? process.env['GRAFANA_URL'];
  if (!url) return null;

  const username = grafanaCfg?.username ?? process.env['GRAFANA_USER'];
  const password = grafanaCfg?.password ?? process.env['GRAFANA_PASSWORD'];

  return new GrafanaMetricsProvider(
    new GrafanaClient({ baseUrl: url, username, password }),
    { defaultStep: 60 },
  );
}

/**
 * Build a `RepoProvider` for every repository in the config. Each provider is
 * pointed at the correct per-repo (or global-fallback) Axon host.
 */
export function repoProviders(config: HorusConfig): RepoProvider[] {
  return config.repos.map((r) => {
    const hostUrl = r.axonHostUrl ?? config.axon.hostUrl;
    return {
      name: r.name,
      path: r.path,
      hostUrl,
      code: new AxonCodeProvider(new AxonHttpClient({ baseUrl: hostUrl })),
    };
  });
}
