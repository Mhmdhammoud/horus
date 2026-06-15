/** Horus release version. */
export const HORUS_VERSION = '0.1.1';

/**
 * The exact Axon version Horus is validated and pinned against. The Axon provider
 * asserts the running Axon matches this (see architecture.md §1, risk R4). A drifted
 * build must fail loudly rather than silently mis-map results.
 */
export const PINNED_AXON_VERSION = '1.0.1';

/** Horus-facing alias for PINNED_AXON_VERSION (HOR-136). */
export const PINNED_SOURCE_VERSION = PINNED_AXON_VERSION;
