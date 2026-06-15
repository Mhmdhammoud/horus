import { PINNED_SOURCE_VERSION } from '@horus/core';
import type { SourceHttpClient } from './axon/source-boundary.js';

export interface SourceCompatibility {
  version: string | null;
  pinned: string;
  matches: boolean;
}

/** Compat alias — use SourceCompatibility in new code (HOR-139). */
export type AxonCompatibility = SourceCompatibility;

export async function checkSourceCompatibility(
  client: SourceHttpClient,
): Promise<SourceCompatibility> {
  const version = await client.version();
  return { version, pinned: PINNED_SOURCE_VERSION, matches: version === PINNED_SOURCE_VERSION };
}

/** Compat shim — use checkSourceCompatibility in new code (HOR-139). */
export async function checkAxonCompatibility(
  client: SourceHttpClient,
): Promise<SourceCompatibility> {
  return checkSourceCompatibility(client);
}
