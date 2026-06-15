import { PINNED_AXON_VERSION } from '@horus/core';
import type { AxonHttpClient } from './axon/client.js';

export interface AxonCompatibility {
  version: string | null;
  pinned: string;
  matches: boolean;
}

export async function checkAxonCompatibility(
  client: AxonHttpClient,
): Promise<AxonCompatibility> {
  const version = await client.version();
  return { version, pinned: PINNED_AXON_VERSION, matches: version === PINNED_AXON_VERSION };
}

// Horus-facing alias (HOR-64); implementation unchanged.
export type SourceCompatibility = AxonCompatibility;

/** Horus-facing delegate for checkAxonCompatibility (HOR-136). */
export async function checkSourceCompatibility(
  client: AxonHttpClient,
): Promise<SourceCompatibility> {
  return checkAxonCompatibility(client);
}
