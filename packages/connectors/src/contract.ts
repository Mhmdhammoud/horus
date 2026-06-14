/**
 * Provider contracts for @horus/connectors.
 *
 * `Provider` is the base interface shared by every data-source adapter.
 * `CodeProvider` extends it with all code-graph operations backed by Axon.
 */

import type {
  Symbol,
  SymbolContext,
  Flow,
  HealthStatus,
  ImpactResult,
  ChangeSet,
  CypherResult,
  ProviderKind,
} from '@horus/core';

/** Minimal interface every provider must satisfy. */
export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  health(): Promise<HealthStatus>;
}

/** Full contract for a code-graph provider (Axon). */
export interface CodeProvider extends Provider {
  searchSymbols(query: string, limit?: number): Promise<Symbol[]>;
  context(symbolId: string): Promise<SymbolContext>;
  impact(symbolId: string, depth?: number): Promise<ImpactResult>;
  flowsFor(symbolId: string): Promise<Flow[]>;
  detectChanges(diff: { base: string; compare: string }): Promise<ChangeSet>;
  cypher(query: string): Promise<CypherResult>;
}
