/**
 * Horus source-intelligence boundary (HOR-136, HOR-137).
 *
 * Exposes Horus-owned names for the source-intelligence layer so the rest of
 * Horus can depend on these abstractions instead of Axon-named identifiers.
 * Each name delegates to the Axon-compatible implementation; the backing names
 * are preserved until the directory rename in HOR-139.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export { AxonHttpClient as SourceHttpClient } from './client.js';
export { AxonHttpError as SourceHttpError } from './client.js';
export type { AxonClientOptions as SourceClientOptions } from './client.js';
export { AxonCodeProvider as SourceCodeProvider } from './provider.js';

import { axonAvailable, getAxonVersion, readAxonHostUrl } from './lifecycle.js';

/** Is the source-intelligence backend binary on PATH? */
export function sourceAvailable(): Promise<boolean> {
  return axonAvailable();
}

/** Return the installed source-intelligence backend version, or null. */
export function getSourceVersion(): Promise<string | null> {
  return getAxonVersion();
}

/**
 * Return the host URL for the source-intelligence backend serving `root`, or null.
 *
 * Resolution order (HOR-137):
 * 1. `.horus/source/host.json` — Horus-owned canonical path (future binary writes here).
 * 2. `.axon/host.json` — legacy path written by the Axon binary (backwards compat).
 */
export function readSourceHostUrl(root: string): string | null {
  const horusPath = join(root, '.horus', 'source', 'host.json');
  if (existsSync(horusPath)) {
    try {
      const j = JSON.parse(readFileSync(horusPath, 'utf8')) as { host_url?: unknown };
      if (typeof j.host_url === 'string') return j.host_url;
    } catch {
      // Corrupt file — fall through to legacy path.
    }
  }
  return readAxonHostUrl(root);
}
