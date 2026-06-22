import { PINNED_SOURCE_VERSION } from '@horus/core';
import type { SourceHttpClient } from './source/client.js';

export interface SourceCompatibility {
  version: string | null;
  pinned: string;
  matches: boolean;
}

export async function checkSourceCompatibility(
  client: SourceHttpClient,
): Promise<SourceCompatibility> {
  const version = await client.version();
  return { version, pinned: PINNED_SOURCE_VERSION, matches: version === PINNED_SOURCE_VERSION };
}
