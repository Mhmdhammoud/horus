/**
 * Horus source-intelligence boundary (HOR-136).
 *
 * Exposes Horus-owned names for the source-intelligence layer so the rest of
 * Horus can depend on these abstractions instead of Axon-named identifiers.
 * Each name delegates to the Axon-compatible implementation; the backing names
 * are preserved until the directory rename in HOR-139.
 */

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

/** Return the host URL the source-intelligence backend recorded for `root`, or null. */
export function readSourceHostUrl(root: string): string | null {
  return readAxonHostUrl(root);
}
