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
