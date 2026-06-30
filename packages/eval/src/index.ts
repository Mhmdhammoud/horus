/**
 * @horus/eval — the read-only accuracy harness (HOR-403).
 *
 * READ-ONLY by construction: this package only reads the outcome-label store + joined investigation
 * reports and transforms them into an evaluable corpus, a baseline hit-rate report (same math as
 * `horus memory accuracy`), and a no-model feature-separation diagnostic. It NEVER writes the
 * outcome_label store — only `horus feedback` + `horus memory confirm` write labels.
 *
 * Surfaced through the CLI as `horus eval build` + `horus eval baseline`.
 */
export * from './types.js';
export {
  buildCorpus,
  serializeCorpus,
  corpusFilename,
  holdoutSplit,
  pickHeadlineCause,
  type ReportResolver,
} from './corpus.js';
export { computeBaseline, featureSeparation } from './baseline.js';
export {
  RERANKER_VERSION,
  MIN_TRAIN_INVESTIGATIONS,
  trainReranker,
  applyReranker,
  deriveLabels,
  collectFeatureKeys,
  extractRawFeatures,
  matchesConfirmedCause,
  baselineTop,
  isRerankerModel,
  type RankableCause,
  type RerankInvestigation,
  type RerankerModel,
  type RerankTrainResult,
  type RerankTrainSkip,
} from './reranker.js';
