/**
 * Pure Grafana dashboard panel extraction and classification (HOR-11 reframe).
 * No I/O — all functions are unit-testable without network access.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MetricKind =
  | 'latency'
  | 'error-rate'
  | 'throughput'
  | 'queue'
  | 'saturation'
  | 'other';

export interface Panel {
  id: number;
  title: string;
  type: string;
  unit: string;
  datasourceUid: string;
  exprs: string[];
  kind: MetricKind;
  /** Set by the provider after walking dashboards. */
  dashboardUid?: string;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a panel into a MetricKind based on title, unit, and exprs.
 * Rules are applied in priority order; the first match wins.
 */
export function classifyPanel(title: string, unit: string, exprs: string[]): MetricKind {
  const lowerTitle = title.toLowerCase();
  const lowerExprs = exprs.map((e) => e.toLowerCase()).join(' ');
  const combined = `${lowerTitle} ${lowerExprs}`;

  // queue — checked first (BullMQ, depth, backlog)
  if (/queue|bullmq|backlog|depth|jobs/.test(combined)) return 'queue';

  // error-rate — errors, 5xx, failures, or status_code=~"5
  if (/error|5xx|fail/.test(combined) || lowerExprs.includes('status_code=~"5')) {
    return 'error-rate';
  }

  // latency — unit "s" or latency/duration/p9x/histogram_quantile in name/exprs
  if (unit === 's' || /latency|duration|p9\d|histogram_quantile/.test(combined)) {
    return 'latency';
  }

  // throughput — unit "reqps" or rate(, throughput, requests_total, operations_total, reqps
  if (
    unit === 'reqps' ||
    /rate\(|throughput|requests_total|operations_total|reqps/.test(combined)
  ) {
    return 'throughput';
  }

  // saturation — unit "percent" or cpu/memory/disk/saturation keywords
  if (unit === 'percent' || /cpu|memory|disk|saturation/.test(combined)) {
    return 'saturation';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Panel extraction
// ---------------------------------------------------------------------------

/**
 * Extract leaf panels from a raw Grafana dashboard object.
 * Recurses into row panels (type === "row") which may carry nested panels.
 */
export function extractPanels(dashboard: unknown): Panel[] {
  const dash = dashboard as Record<string, unknown> | null | undefined;
  if (dash == null) return [];

  const panels = dash['panels'];
  if (!Array.isArray(panels)) return [];

  const result: Panel[] = [];
  walkPanels(panels, result);
  return result;
}

function walkPanels(panels: unknown[], result: Panel[]): void {
  for (const raw of panels) {
    const p = raw as Record<string, unknown>;
    const type = String(p['type'] ?? '');

    if (type === 'row') {
      // Row panels may carry nested panels
      const nested = p['panels'];
      if (Array.isArray(nested)) {
        walkPanels(nested, result);
      }
      continue;
    }

    const id = typeof p['id'] === 'number' ? p['id'] : Number(p['id'] ?? 0);
    const title = String(p['title'] ?? '');
    const fieldConfig = p['fieldConfig'] as Record<string, unknown> | undefined;
    const defaults = fieldConfig?.['defaults'] as Record<string, unknown> | undefined;
    const unit = String(defaults?.['unit'] ?? 'none');

    // Resolve datasource uid
    const dsRaw = p['datasource'];
    let datasourceUid = '';
    if (typeof dsRaw === 'string') {
      datasourceUid = dsRaw;
    } else if (dsRaw !== null && typeof dsRaw === 'object') {
      const ds = dsRaw as Record<string, unknown>;
      datasourceUid = String(ds['uid'] ?? '');
    }

    // Extract PromQL expressions from targets
    const targets = p['targets'];
    const exprs: string[] = [];
    if (Array.isArray(targets)) {
      for (const t of targets) {
        const target = t as Record<string, unknown>;
        const expr = target['expr'];
        if (typeof expr === 'string' && expr !== '') {
          exprs.push(expr);
        }
      }
    }

    const kind = classifyPanel(title, unit, exprs);
    result.push({ id, title, type, unit, datasourceUid, exprs, kind });
  }
}

// ---------------------------------------------------------------------------
// Expression sanitization
// ---------------------------------------------------------------------------

/**
 * Replace Grafana macro variables ($__rate_interval, $__interval) with "5m".
 * If the expression still contains a "$" after substitution, return null
 * (unresolvable template variable — caller should skip this target).
 */
export function sanitizeExpr(expr: string): string | null {
  const replaced = expr
    .replace(/\$__rate_interval/g, '5m')
    .replace(/\$__interval/g, '5m');
  if (replaced.includes('$')) return null;
  return replaced;
}

// ---------------------------------------------------------------------------
// Hint matching
// ---------------------------------------------------------------------------

/**
 * Tokenize a hint string for panel matching.
 *
 * Splits on camelCase boundaries and snake_case underscores in addition to
 * non-alphanumeric delimiters, then lowercases and drops tokens shorter than
 * 3 characters.
 *
 * Examples:
 *   "getSaleWithLink"              → ["get", "sale", "with", "link"]
 *   "http_request_rate"            → ["http", "request", "rate"]
 *   "GraphQL p95 Latency"          → ["graphql", "p95", "latency"]
 *   "getSaleWithLink slow timeout" → ["get", "sale", "with", "link", "slow", "timeout"]
 */
export function extractHintTokens(hint: string): string[] {
  // camelCase split: insert a space before each uppercase letter that follows a
  // lowercase letter ("getSale" → "get Sale")
  const camelSplit = hint.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Acronym split: "XMLParser" → "XML Parser"
  const acronymSplit = camelSplit.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return acronymSplit
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Returns true if the panel is relevant to the given hint.
 * - An empty/undefined hint matches every panel.
 * - Otherwise, at least one token from `hint` (split via `extractHintTokens`,
 *   which handles camelCase and snake_case) must appear in the lowercased panel
 *   title or any expression.
 *
 * This means `"getSaleWithLink"` will match a panel titled "Sale Latency"
 * because the hint tokenises to ["get", "sale", "with", "link"] and "sale"
 * is present in the panel title.
 */
export function panelMatchesHint(p: Panel, hint: string): boolean {
  if (hint === '') return true;
  const tokens = extractHintTokens(hint);
  if (tokens.length === 0) return true;

  const haystack =
    p.title.toLowerCase() + ' ' + p.exprs.map((e) => e.toLowerCase()).join(' ');

  return tokens.some((tok) => haystack.includes(tok));
}
