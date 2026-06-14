/**
 * ConnectorFactory — wires a validated `HorusConfig` into live provider instances.
 *
 * v0 ships only the Axon-backed code provider; runtime providers (ES, Prometheus,
 * Redis, BullMQ, Git) join the `Connectors` bundle in HOR-5.
 */

import type { HorusConfig } from '@horus/core';
import { AxonHttpClient } from './axon/client.js';
import { AxonCodeProvider } from './axon/provider.js';
import type { CodeProvider } from './contract.js';

export interface Connectors {
  code: CodeProvider;
}

export function createConnectors(config: HorusConfig): Connectors {
  return {
    code: new AxonCodeProvider(new AxonHttpClient({ baseUrl: config.axon.hostUrl })),
  };
}
