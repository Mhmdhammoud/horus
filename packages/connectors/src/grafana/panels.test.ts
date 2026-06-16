/**
 * Pure unit tests for grafana/panels.ts (HOR-11 reframe). No network — no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  extractPanels,
  classifyPanel,
  sanitizeExpr,
  panelMatchesHint,
  extractHintTokens,
  findMatchSource,
  findingLabelsMatchHint,
} from './panels.js';

// ---------------------------------------------------------------------------
// Fixture dashboard with a row containing 2 panels
// ---------------------------------------------------------------------------

const fixtureDashboard = {
  title: 'Test Dashboard',
  panels: [
    {
      id: 1,
      title: 'Overview Row',
      type: 'row',
      panels: [
        {
          id: 2,
          title: 'HTTP p95 Latency',
          type: 'timeseries',
          fieldConfig: { defaults: { unit: 's' } },
          datasource: { uid: 'Prometheus' },
          targets: [
            {
              expr: 'histogram_quantile(0.95, sum by (le,route)(rate(maison_safqa_http_request_duration_seconds_bucket[5m])))',
            },
          ],
        },
        {
          id: 3,
          title: 'BullMQ Queue Depth',
          type: 'stat',
          fieldConfig: { defaults: { unit: 'short' } },
          datasource: { uid: 'Prometheus' },
          targets: [{ expr: 'maison_safqa_bullmq_queue_jobs' }],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// extractPanels
// ---------------------------------------------------------------------------

describe('extractPanels', () => {
  it('extracts leaf panels from a row (skips the row itself)', () => {
    const panels = extractPanels(fixtureDashboard);
    expect(panels).toHaveLength(2);
  });

  it('reads correct unit from fieldConfig.defaults.unit', () => {
    const panels = extractPanels(fixtureDashboard);
    expect(panels[0]?.unit).toBe('s');
    expect(panels[1]?.unit).toBe('short');
  });

  it('reads datasourceUid from datasource.uid', () => {
    const panels = extractPanels(fixtureDashboard);
    expect(panels[0]?.datasourceUid).toBe('Prometheus');
    expect(panels[1]?.datasourceUid).toBe('Prometheus');
  });

  it('reads exprs from targets[].expr', () => {
    const panels = extractPanels(fixtureDashboard);
    expect(panels[0]?.exprs).toHaveLength(1);
    expect(panels[0]?.exprs[0]).toContain('histogram_quantile');
    expect(panels[1]?.exprs[0]).toBe('maison_safqa_bullmq_queue_jobs');
  });

  it('reads panel id and title', () => {
    const panels = extractPanels(fixtureDashboard);
    expect(panels[0]?.id).toBe(2);
    expect(panels[0]?.title).toBe('HTTP p95 Latency');
    expect(panels[1]?.id).toBe(3);
    expect(panels[1]?.title).toBe('BullMQ Queue Depth');
  });

  it('returns [] for null dashboard', () => {
    expect(extractPanels(null)).toEqual([]);
  });

  it('returns [] for dashboard with no panels array', () => {
    expect(extractPanels({ title: 'empty' })).toEqual([]);
  });

  it('handles a string datasource uid', () => {
    const dash = {
      panels: [
        {
          id: 10,
          title: 'Simple',
          type: 'timeseries',
          fieldConfig: { defaults: { unit: 'none' } },
          datasource: 'DS_PROMETHEUS',
          targets: [{ expr: 'up' }],
        },
      ],
    };
    const panels = extractPanels(dash);
    expect(panels[0]?.datasourceUid).toBe('DS_PROMETHEUS');
  });
});

// ---------------------------------------------------------------------------
// classifyPanel
// ---------------------------------------------------------------------------

describe('classifyPanel', () => {
  it('classifies HTTP p95 Latency (unit "s") as latency', () => {
    expect(
      classifyPanel('HTTP p95 Latency', 's', [
        'histogram_quantile(0.95, sum by (le,route)(rate(maison_safqa_http_request_duration_seconds_bucket[5m])))',
      ]),
    ).toBe('latency');
  });

  it('classifies BullMQ Queue Depth (unit "short", expr contains jobs) as queue', () => {
    expect(
      classifyPanel('BullMQ Queue Depth', 'short', ['maison_safqa_bullmq_queue_jobs']),
    ).toBe('queue');
  });

  it('classifies HTTP Request Rate (unit "reqps") as throughput', () => {
    expect(
      classifyPanel('HTTP Request Rate', 'reqps', [
        'sum by (route,status_code)(rate(maison_safqa_http_requests_total[5m]))',
      ]),
    ).toBe('throughput');
  });

  it('classifies Host CPU Usage (unit "percent") as saturation', () => {
    expect(classifyPanel('Host CPU Usage', 'percent', [])).toBe('saturation');
  });

  it('classifies a queue panel before a throughput panel (queue keyword wins)', () => {
    expect(classifyPanel('Job Queue Rate', 'reqps', ['queue_depth'])).toBe('queue');
  });

  it('classifies an unrecognised panel as other', () => {
    expect(classifyPanel('Scrape Target Health', 'none', ['up'])).toBe('other');
  });

  it('classifies GraphQL p95 Latency as latency via expr keyword', () => {
    expect(
      classifyPanel('GraphQL p95 Latency', 's', [
        'histogram_quantile(0.95, rate(graphql_duration_seconds_bucket[5m]))',
      ]),
    ).toBe('latency');
  });

  it('classifies error-rate panel via title keyword', () => {
    expect(classifyPanel('HTTP 5xx Errors', 'none', [])).toBe('error-rate');
  });
});

// ---------------------------------------------------------------------------
// sanitizeExpr
// ---------------------------------------------------------------------------

describe('sanitizeExpr', () => {
  it('replaces $__rate_interval with 5m', () => {
    expect(sanitizeExpr('rate(x[$__rate_interval])')).toBe('rate(x[5m])');
  });

  it('replaces $__interval with 5m', () => {
    expect(sanitizeExpr('rate(x[$__interval])')).toBe('rate(x[5m])');
  });

  it('returns null when a non-macro $ variable remains', () => {
    expect(sanitizeExpr('foo{job="$svc"}')).toBeNull();
  });

  it('returns the expression unchanged when there are no variables', () => {
    expect(sanitizeExpr('up')).toBe('up');
  });

  it('replaces multiple occurrences in one expression', () => {
    const result = sanitizeExpr(
      'rate(x[$__rate_interval]) / rate(y[$__interval])',
    );
    expect(result).toBe('rate(x[5m]) / rate(y[5m])');
  });

  it('returns null when expression has both macro and unknown variable', () => {
    // After replacing macros, $svc still remains
    expect(sanitizeExpr('rate(x[$__interval]){job="$svc"}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// panelMatchesHint
// ---------------------------------------------------------------------------

describe('panelMatchesHint', () => {
  const latencyPanel = {
    id: 1,
    title: 'HTTP p95 Latency',
    type: 'timeseries',
    unit: 's',
    datasourceUid: 'Prometheus',
    exprs: ['histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))'],
    kind: 'latency' as const,
  };

  it('returns true for empty hint (matches everything)', () => {
    expect(panelMatchesHint(latencyPanel, '')).toBe(true);
  });

  it('returns true when hint token appears in panel title', () => {
    expect(panelMatchesHint(latencyPanel, 'latency')).toBe(true);
  });

  it('returns true when hint token appears in an expression', () => {
    expect(panelMatchesHint(latencyPanel, 'histogram_quantile')).toBe(true);
  });

  it('returns false when hint does not match title or exprs', () => {
    expect(panelMatchesHint(latencyPanel, 'redis')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(panelMatchesHint(latencyPanel, 'HTTP')).toBe(true);
  });

  it('returns true if at least one token matches (partial hint)', () => {
    // "http redis" — "http" matches, "redis" does not
    expect(panelMatchesHint(latencyPanel, 'http redis')).toBe(true);
  });

  it('matches a camelCase hint by splitting into tokens (HOR-159)', () => {
    // "getSaleWithLink" → ["get", "sale", "with", "link"]
    // latencyPanel title "HTTP p95 Latency" does not contain any of these, but
    // a sale panel would.
    const salePanel = {
      id: 10,
      title: 'Sale Latency p95',
      type: 'timeseries',
      unit: 's',
      datasourceUid: 'Prometheus',
      exprs: ['histogram_quantile(0.95, rate(sale_duration_seconds_bucket[5m]))'],
      kind: 'latency' as const,
    };
    expect(panelMatchesHint(salePanel, 'getSaleWithLink')).toBe(true);
  });

  it('does NOT match an unrelated panel with a camelCase hint', () => {
    // "getSaleWithLink" → ["get", "sale", "with", "link"]
    // None of these appear in "BullMQ Queue Depth" or its exprs
    const queuePanel = {
      id: 20,
      title: 'BullMQ Queue Depth',
      type: 'stat',
      unit: 'short',
      datasourceUid: 'Prometheus',
      exprs: ['maison_safqa_bullmq_queue_jobs'],
      kind: 'queue' as const,
    };
    expect(panelMatchesHint(queuePanel, 'getSaleWithLink')).toBe(false);
  });

  it('matches a camelCase hint in expressions too', () => {
    const exprPanel = {
      id: 30,
      title: 'Custom Panel',
      type: 'timeseries',
      unit: 'none',
      datasourceUid: 'Prometheus',
      exprs: ['rate(sale_request_total[5m])'],
      kind: 'other' as const,
    };
    // "getSaleWithLink" splits to ["get","sale","with","link"]; "sale" in expr
    expect(panelMatchesHint(exprPanel, 'getSaleWithLink')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractHintTokens — camelCase and snake_case splitting (HOR-159)
// ---------------------------------------------------------------------------

describe('extractHintTokens', () => {
  it('splits camelCase into tokens', () => {
    expect(extractHintTokens('getSaleWithLink')).toEqual(['get', 'sale', 'with', 'link']);
  });

  it('splits snake_case into tokens', () => {
    expect(extractHintTokens('http_request_rate')).toEqual(['http', 'request', 'rate']);
  });

  it('splits an investigation hint with mixed casing and spaces', () => {
    const tokens = extractHintTokens('getSaleWithLink slow');
    expect(tokens).toContain('sale');
    expect(tokens).toContain('link');
    expect(tokens).toContain('slow');
  });

  it('filters tokens shorter than 3 characters', () => {
    // "getA" → ["get"] ("a" filtered)
    const tokens = extractHintTokens('getA');
    expect(tokens).not.toContain('a');
    expect(tokens).toContain('get');
  });

  it('handles plain lowercase words without modification', () => {
    expect(extractHintTokens('latency spike')).toEqual(['latency', 'spike']);
  });

  it('handles acronym splits (XMLParser → xml, parser)', () => {
    const tokens = extractHintTokens('XMLParser');
    expect(tokens).toContain('xml');
    expect(tokens).toContain('parser');
  });

  it('returns empty array for an empty string', () => {
    expect(extractHintTokens('')).toEqual([]);
  });

  it('deduplicates naturally — no tokens shorter than 3 survive', () => {
    const tokens = extractHintTokens('p95 p99');
    expect(tokens).toEqual(['p95', 'p99']);
  });
});

// ---------------------------------------------------------------------------
// findMatchSource — HOR-188
// ---------------------------------------------------------------------------

describe('findMatchSource', () => {
  const panel = {
    id: 1,
    title: 'Webhook Request Rate',
    type: 'timeseries',
    unit: 'reqps',
    datasourceUid: 'Prometheus',
    exprs: ['rate(shopify_webhook_requests_total[5m])'],
    kind: 'throughput' as const,
  };

  it('returns "panel-title" when token matches the panel title', () => {
    expect(findMatchSource({ ...panel, title: 'Shopify Webhook Rate' }, 'shopify')).toBe('panel-title');
  });

  it('returns "query-text" when token matches an expression but not the title', () => {
    // panel title "Webhook Request Rate" does NOT contain "shopify"; expr does.
    expect(findMatchSource(panel, 'shopify')).toBe('query-text');
  });

  it('returns null when hint does not match title or exprs', () => {
    expect(findMatchSource(panel, 'redis')).toBeNull();
  });

  it('returns null when hint is empty', () => {
    expect(findMatchSource(panel, '')).toBeNull();
  });

  it('panel-title takes precedence over query-text', () => {
    const both = { ...panel, title: 'Shopify Rate', exprs: ['rate(shopify_total[5m])'] };
    expect(findMatchSource(both, 'shopify')).toBe('panel-title');
  });
});

// ---------------------------------------------------------------------------
// findingLabelsMatchHint — HOR-188
// ---------------------------------------------------------------------------

describe('findingLabelsMatchHint', () => {
  it('returns true when a label value matches the hint token', () => {
    expect(findingLabelsMatchHint({ source: 'shopify', topic: 'product-delete' }, 'shopify')).toBe(true);
  });

  it('returns false when no label value matches', () => {
    expect(findingLabelsMatchHint({ source: 'internal', topic: 'user-created' }, 'shopify')).toBe(false);
  });

  it('returns true for empty hint (matches everything)', () => {
    expect(findingLabelsMatchHint({ source: 'shopify' }, '')).toBe(true);
  });

  it('matches partial label value (token inside longer value)', () => {
    expect(findingLabelsMatchHint({ operation_name: 'shopify_webhook_handler' }, 'shopify')).toBe(true);
  });

  it('is case-insensitive on label values', () => {
    expect(findingLabelsMatchHint({ source: 'Shopify' }, 'shopify')).toBe(true);
  });

  it('returns false for empty labels and non-empty hint', () => {
    expect(findingLabelsMatchHint({}, 'shopify')).toBe(false);
  });
});
