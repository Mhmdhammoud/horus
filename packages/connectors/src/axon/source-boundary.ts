/**
 * Horus source-intelligence boundary (HOR-136, HOR-137, HOR-142).
 *
 * Exposes Horus-owned names for the source-intelligence layer so the rest of
 * Horus can depend on these abstractions instead of Axon-named identifiers.
 * Each name delegates to the Axon-compatible implementation; the backing names
 * are preserved until the directory rename in HOR-139.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Client class / error / options
export { AxonHttpClient as SourceHttpClient } from './client.js';
export { AxonHttpError as SourceHttpError } from './client.js';
export type { AxonClientOptions as SourceClientOptions } from './client.js';

// Code provider
export { AxonCodeProvider as SourceCodeProvider } from './provider.js';

// Response / wire types (HOR-142)
export type {
  SourceNode,
  SourceSearchResult,
  SourceCypherResult,
  SourceImpactResult,
  SourceDiffResult,
  SourceOverview,
  SourceHostInfo,
  SourceHealth,
} from './types.js';

import { axonAvailable, getAxonVersion, resolveSourceBin } from './lifecycle.js';

/** Is `horus-source` on PATH? */
export function sourceAvailable(): Promise<boolean> {
  return axonAvailable();
}

/** Return the installed `horus-source` version, or null if not found. */
export function getSourceVersion(): Promise<string | null> {
  return getAxonVersion();
}

/** Resolve the active source-intelligence binary name, or null if not installed. */
export function getActiveSourceBin(): Promise<string | null> {
  return resolveSourceBin();
}

/**
 * Return the host URL for the source-intelligence backend serving `root`, or null.
 * Reads from `.horus/source/host.json` — the canonical path written by horus-source.
 */
export function readSourceHostUrl(root: string): string | null {
  const horusPath = join(root, '.horus', 'source', 'host.json');
  if (existsSync(horusPath)) {
    try {
      const j = JSON.parse(readFileSync(horusPath, 'utf8')) as { host_url?: unknown };
      if (typeof j.host_url === 'string') return j.host_url;
    } catch {
      return null;
    }
  }
  return null;
}
