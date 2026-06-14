/**
 * Pure unit tests for grafana/panels.ts (HOR-11 reframe). No network — no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  extractPanels,
  classifyPanel,
  sanitizeExpr,
  panelMatchesHint,
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
});
