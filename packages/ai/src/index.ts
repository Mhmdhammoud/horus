/**
 * @horus/ai — AI narrative contract, citation validator, and provider interface.
 *
 * HOR-51: defines the data boundary between the deterministic investigation engine
 * and any AI narrative provider. No live provider calls — the contract and validator
 * are pure and testable without API keys.
 *
 * AI never replaces deterministic scoring. It only annotates it.
 * See architecture.md §2.7 and docs/source-intelligence-boundary.md.
 */

export type {
  NarrativeEvidenceItem,
  NarrativeCauseItem,
  NarrativeInput,
  NarrativeOutput,
  NarrativeCitation,
  NarrativeProvider,
  NarrativeProviderOptions,
  NarrativeValidationResult,
  RenderNarrativeOptions,
  RenderNarrativeResult,
} from './contract.js';

export { validateNarrative, renderNarrative } from './contract.js';
