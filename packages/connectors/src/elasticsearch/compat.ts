/**
 * Runtime mapping compatibility checks for Elasticsearch (HOR-47).
 *
 * Pure: takes a `_field_caps` response, returns structured diagnostics with
 * no I/O. Call from the provider's checkCompatibility() method.
 */

import type { ElasticsearchFieldMapping } from './normalize.js';

export interface CompatibilityIssue {
  severity: 'error' | 'warning';
  field: string;
  message: string;
}

export interface CompatibilityReport {
  /** False when any error-severity issue is present. */
  ok: boolean;
  /** Number of indices the pattern matched. 0 means no data will ever be found. */
  indexCount: number;
  issues: CompatibilityIssue[];
}

export interface CompatibilityOptions {
  /**
   * Whether the caller will apply a service filter.
   * When true, a missing or incompatible service field is elevated from
   * warning to error — an empty service filter guarantees zero results.
   */
  requiresService?: boolean;
  /**
   * Whether the caller will run terms aggregations on the service field
   * (i.e. analyzeErrors() is about to be called — per-signature services and
   * global affected_services are always aggregated).
   * When true, a non-aggregatable service field is elevated from warning to
   * error — Elasticsearch may reject the entire analysis query, not just omit
   * the services breakdown.
   */
  requiresServiceAggregation?: boolean;
  /**
   * Whether the caller will aggregate error signatures by event-code field
   * (i.e. analyzeErrors() is about to be called).
   * When true, a missing or non-aggregatable event-code field is elevated from
   * warning to error — errors match but produce empty signature buckets,
   * misreported downstream as "no matching logs."
   */
  requiresEventCode?: boolean;
}

const DATE_TYPES = new Set(['date', 'date_nanos']);
const NUMERIC_TYPES = new Set([
  'long', 'integer', 'short', 'byte', 'double', 'float',
  'half_float', 'scaled_float', 'unsigned_long',
]);
const KEYWORD_TYPES = new Set(['keyword', 'constant_keyword', 'wildcard']);
const STRING_LEVEL_TYPES = new Set(['keyword', 'constant_keyword', 'wildcard', 'text']);

/**
 * Validate an ElasticsearchFieldMapping against a `_field_caps` API response.
 *
 * Returns a CompatibilityReport with actionable diagnostics. Errors block
 * investigation (wrong field type, missing timestamp/level). Warnings degrade
 * specific aggregation behaviour (missing keyword sub-field, absent service field).
 */
export function validateMappingAgainstCaps(
  mapping: ElasticsearchFieldMapping,
  fieldCapsResponse: unknown,
  opts: CompatibilityOptions = {},
): CompatibilityReport {
  const res = fieldCapsResponse as Record<string, unknown>;
  const indices = (res['indices'] ?? []) as string[];
  const fields = (res['fields'] ?? {}) as Record<string, Record<string, unknown>>;

  const issues: CompatibilityIssue[] = [];

  if (indices.length === 0) {
    issues.push({
      severity: 'error',
      field: '(index)',
      message:
        'Index pattern matched no indices. Horus will find no evidence. ' +
        'Check the indexPattern in your connector config.',
    });
    return { ok: false, indexCount: 0, issues };
  }

  const presentTypes = (fieldName: string): string[] =>
    Object.keys(fields[fieldName] ?? {});

  // All present types must be in the allowed set (not just one). This catches
  // mixed-mapping scenarios where a field is typed differently across rolling
  // or multi-service indices — e.g. level: long in one index, keyword in another.
  const hasType = (fieldName: string, allowed: Set<string>): boolean => {
    const types = presentTypes(fieldName);
    return types.length > 0 && types.every((t) => allowed.has(t));
  };

  const incompatibleTypes = (fieldName: string, allowed: Set<string>): string[] =>
    presentTypes(fieldName).filter((t) => !allowed.has(t));

  // Check that every entry for fieldName whose type is in `allowed` has the
  // given capability set to true. Called only after hasType() passes, so all
  // present types are already in `allowed` — the filter just makes it explicit.
  const hasCapability = (
    fieldName: string,
    allowed: Set<string>,
    cap: 'searchable' | 'aggregatable',
  ): boolean => {
    const typeMap = fields[fieldName] ?? {};
    const relevant = Object.entries(typeMap).filter(([t]) => allowed.has(t));
    if (relevant.length === 0) return false;
    return relevant.every(([, info]) => (info as Record<string, unknown>)[cap] === true);
  };

  // --- Timestamp field ---
  const tsTypes = presentTypes(mapping.timestampField);
  if (tsTypes.length === 0) {
    const dateFields = Object.entries(fields)
      .filter(([, types]) => Object.keys(types).some((t) => DATE_TYPES.has(t)))
      .map(([f]) => f)
      .slice(0, 5);
    issues.push({
      severity: 'error',
      field: mapping.timestampField,
      message:
        `Timestamp field '${mapping.timestampField}' not found in index. ` +
        `Available date fields: ${dateFields.join(', ') || '(none)'}. ` +
        `Set fields.timestamp in your connector config.`,
    });
  } else if (!hasType(mapping.timestampField, DATE_TYPES)) {
    const bad = incompatibleTypes(mapping.timestampField, DATE_TYPES);
    issues.push({
      severity: 'error',
      field: mapping.timestampField,
      message:
        `Timestamp field '${mapping.timestampField}' has incompatible type(s) [${bad.join(', ')}] — ` +
        `all observed types must be date or date_nanos. ` +
        `Horus cannot build time-range queries.`,
    });
  } else if (!hasCapability(mapping.timestampField, DATE_TYPES, 'searchable')) {
    issues.push({
      severity: 'error',
      field: mapping.timestampField,
      message:
        `Timestamp field '${mapping.timestampField}' is not searchable — ` +
        `time-range queries will return no results.`,
    });
  }

  // --- Level field ---
  const lvTypes = presentTypes(mapping.levelField);
  if (lvTypes.length === 0) {
    issues.push({
      severity: 'error',
      field: mapping.levelField,
      message:
        `Level field '${mapping.levelField}' not found in index. ` +
        `Confirm levelField and levelFormat in your connector config.`,
    });
  } else if (mapping.levelFormat === 'numeric' && !hasType(mapping.levelField, NUMERIC_TYPES)) {
    const bad = incompatibleTypes(mapping.levelField, NUMERIC_TYPES);
    issues.push({
      severity: 'error',
      field: mapping.levelField,
      message:
        `Level field '${mapping.levelField}' has incompatible type(s) [${bad.join(', ')}] but ` +
        `levelFormat is 'numeric'. Set fields.levelFormat: 'string' or point to a numeric field.`,
    });
  } else if (mapping.levelFormat === 'string' && !hasType(mapping.levelField, STRING_LEVEL_TYPES)) {
    const bad = incompatibleTypes(mapping.levelField, STRING_LEVEL_TYPES);
    issues.push({
      severity: 'error',
      field: mapping.levelField,
      message:
        `Level field '${mapping.levelField}' has incompatible type(s) [${bad.join(', ')}] but ` +
        `levelFormat is 'string'. Set fields.levelFormat: 'numeric' or point to a keyword/text field.`,
    });
  } else {
    const lvAllowed = mapping.levelFormat === 'numeric' ? NUMERIC_TYPES : STRING_LEVEL_TYPES;
    if (!hasCapability(mapping.levelField, lvAllowed, 'searchable')) {
      issues.push({
        severity: 'error',
        field: mapping.levelField,
        message:
          `Level field '${mapping.levelField}' is not searchable — ` +
          `level filter queries will return no results.`,
      });
    }
  }

  // --- Service field ---
  // svcSeverity governs filter-path checks (missing field, non-searchable).
  // svcAggSeverity governs aggregation-path checks (non-aggregatable): elevated
  // when analyzeErrors() is about to run terms aggs on this field.
  const svcSeverity: 'error' | 'warning' = opts.requiresService ? 'error' : 'warning';
  const svcAggSeverity: 'error' | 'warning' = opts.requiresServiceAggregation ? 'error' : 'warning';
  const svcTypes = presentTypes(mapping.serviceField);
  const svcKwField = `${mapping.serviceField}.keyword`;
  if (svcTypes.length === 0 && presentTypes(svcKwField).length === 0) {
    issues.push({
      severity: svcSeverity,
      field: mapping.serviceField,
      message:
        `Service field '${mapping.serviceField}' not found. ` +
        (opts.requiresService
          ? `Cannot apply service filter — collection blocked to avoid a guaranteed empty result.`
          : `Service filtering and aggregations will return no results.`),
    });
  } else if (mapping.serviceKeyword && !hasType(svcKwField, KEYWORD_TYPES)) {
    issues.push({
      severity: svcSeverity,
      field: svcKwField,
      message:
        `serviceKeyword is true but '${svcKwField}' has no keyword sub-field. ` +
        (opts.requiresService
          ? `Service filter will fail — collection blocked. `
          : `Service aggregations may fail. `) +
        `Set fields.serviceKeyword: false if '${mapping.serviceField}' is already keyword-typed.`,
    });
  } else {
    // Type check passed — validate searchable (filter) and aggregatable (agg) capabilities
    // on whichever field will actually be used for terms queries and aggregations.
    const capField = mapping.serviceKeyword ? svcKwField : mapping.serviceField;
    if (presentTypes(capField).length > 0) {
      if (!hasCapability(capField, KEYWORD_TYPES, 'searchable')) {
        issues.push({
          severity: svcSeverity,
          field: capField,
          message:
            `Service field '${capField}' is not searchable — ` +
            (opts.requiresService
              ? `service filter will return empty results — collection blocked.`
              : `service filter will return empty results.`),
        });
      }
      if (!hasCapability(capField, KEYWORD_TYPES, 'aggregatable')) {
        issues.push({
          severity: svcAggSeverity,
          field: capField,
          message:
            `Service field '${capField}' is not aggregatable — ` +
            (opts.requiresServiceAggregation
              ? `analyzeErrors() runs service terms aggregations that Elasticsearch may reject — collection blocked.`
              : `affected services aggregation will return empty results.`),
        });
      }
    }
  }

  // --- EventCode field ---
  // Elevated to error when signature aggregation will be performed: a missing
  // or non-aggregatable event-code field yields empty buckets even when error
  // hits exist, which is misreported as "no matching logs."
  const ecSeverity: 'error' | 'warning' = opts.requiresEventCode ? 'error' : 'warning';
  const ecKwField = `${mapping.eventCodeField}.keyword`;
  if (mapping.eventCodeKeyword && !hasType(ecKwField, KEYWORD_TYPES)) {
    issues.push({
      severity: ecSeverity,
      field: ecKwField,
      message:
        `eventCodeKeyword is true but '${ecKwField}' not found or has no keyword type. ` +
        (opts.requiresEventCode
          ? `Error signature aggregation blocked — collection would report zero signatures despite matching errors. `
          : `Error signature aggregations will fail. `) +
        `Set fields.eventCodeKeyword: false if '${mapping.eventCodeField}' is already keyword-typed.`,
    });
  } else if (!mapping.eventCodeKeyword && !hasType(mapping.eventCodeField, KEYWORD_TYPES)) {
    issues.push({
      severity: ecSeverity,
      field: mapping.eventCodeField,
      message:
        (opts.requiresEventCode
          ? `Event code field '${mapping.eventCodeField}' is not aggregatable — signature aggregation blocked. `
          : `Event code field '${mapping.eventCodeField}' has no keyword type. `) +
        `Error signature aggregations may not work correctly.`,
    });
  } else {
    // Type check passed — validate aggregatable capability for terms aggregation.
    const ecCapField = mapping.eventCodeKeyword ? ecKwField : mapping.eventCodeField;
    if (!hasCapability(ecCapField, KEYWORD_TYPES, 'aggregatable')) {
      issues.push({
        severity: ecSeverity,
        field: ecCapField,
        message:
          (opts.requiresEventCode
            ? `Event code field '${ecCapField}' is not aggregatable — signature aggregation blocked. `
            : `Event code field '${ecCapField}' is not aggregatable — `) +
          `Error signatures cannot be grouped by event code.`,
      });
    }
  }

  const hasErrors = issues.some((i) => i.severity === 'error');
  return { ok: !hasErrors, indexCount: indices.length, issues };
}
