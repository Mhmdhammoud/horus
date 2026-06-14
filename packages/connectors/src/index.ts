/**
 * @horus/connectors — provider contracts + implementations.
 *
 * HOR-3 defines the `Provider` / `CodeProvider` contracts and `ConnectorFactory`,
 * plus the Axon provider (HTTP/MCP transport only — no CLI shell-outs for queries).
 * HOR-5 adds the runtime providers (ES, Prometheus, Redis, BullMQ, Git).
 * See architecture.md §2.2.
 */

export * from './axon/index.js';
export * from './contract.js';
export * from './factory.js';
export * from './axon/provider.js';
export * from './compat.js';
export * from './git/index.js';
export * from './elasticsearch/index.js';
export * from './prometheus/index.js';
