/**
 * Tests for validateMappingAgainstCaps (HOR-47 runtime compatibility check).
 * All tests are pure — no Elasticsearch calls, no network.
 */

import { describe, it, expect } from 'vitest';
import { validateMappingAgainstCaps } from './compat.js';
import { MERITT_FIELD_MAPPING, ECS_FIELD_MAPPING } from './normalize.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal _field_caps response for testing. */
function makeCaps(
  indices: string[],
  fields: Record<string, Record<string, unknown>>,
): unknown {
  return { indices, fields };
}

const MERITT_CAPS = makeCaps(['logs-prod-2026-06-15'], {
  time: { date: { type: 'date', searchable: true, aggregatable: true } },
  level: { long: { type: 'long', searchable: true, aggregatable: true } },
  service_name: {
    text: { type: 'text', searchable: true, aggregatable: false },
  },
  'service_name.keyword': {
    keyword: { type: 'keyword', searchable: true, aggregatable: true },
  },
  event_code: {
    text: { type: 'text', searchable: true, aggregatable: false },
  },
  'event_code.keyword': {
    keyword: { type: 'keyword', searchable: true, aggregatable: true },
  },
  trace_id: { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
});

const ECS_CAPS = makeCaps(['logs-app-2026-06-15'], {
  '@timestamp': { date: { type: 'date', searchable: true, aggregatable: true } },
  'log.level': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
  'service.name': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
  'event.code': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
  'trace.id': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
  'http.request.id': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
});

// ---------------------------------------------------------------------------
// Index existence
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — index existence', () => {
  it('returns ok:false and an error when indices array is empty', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, makeCaps([], {}));
    expect(report.ok).toBe(false);
    expect(report.indexCount).toBe(0);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.severity).toBe('error');
    expect(report.issues[0]?.message).toContain('no indices');
  });

  it('reports the matched index count', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, MERITT_CAPS);
    expect(report.indexCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Meritt mapping against correct caps
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — Meritt correct caps', () => {
  it('returns ok:true with no errors for a fully correct Meritt schema', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, MERITT_CAPS);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ECS mapping against correct caps
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — ECS correct caps', () => {
  it('returns ok:true with no errors for a fully correct ECS schema', () => {
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, ECS_CAPS);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Timestamp field errors
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — timestamp field', () => {
  it('errors when timestamp field is missing', () => {
    const caps = makeCaps(['idx'], {
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'time');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain("'time'");
    expect(err?.message).toContain('not found');
  });

  it('errors when timestamp field exists but has wrong type (e.g. keyword)', () => {
    const caps = makeCaps(['idx'], {
      time: { keyword: { type: 'keyword' } },
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'time');
    expect(err?.message).toContain('date or date_nanos');
    expect(err?.message).toContain('[keyword]');
  });

  it('errors when timestamp field has mixed types including an incompatible one', () => {
    // date across some indices, keyword in others — still fails because not all are date
    const caps = makeCaps(['idx-a', 'idx-b'], {
      time: { date: {}, keyword: {} },
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'time');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('[keyword]');
  });

  it('lists available date fields in the error message', () => {
    const caps = makeCaps(['idx'], {
      '@timestamp': { date: {} },
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const err = report.issues.find((i) => i.field === 'time');
    expect(err?.message).toContain('@timestamp');
  });
});

// ---------------------------------------------------------------------------
// Level field errors
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — level field', () => {
  it('errors when level field is missing', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'level');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain("'level'");
  });

  it('errors when levelFormat:numeric but field is keyword-typed', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      level: { keyword: { type: 'keyword' } },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'level');
    expect(err?.message).toContain("levelFormat is 'numeric'");
    expect(err?.message).toContain("levelFormat: 'string'");
    expect(err?.message).toContain('[keyword]');
  });

  it('errors when levelFormat:numeric but field has mixed long+keyword across indices', () => {
    const caps = makeCaps(['idx-a', 'idx-b'], {
      time: { date: {} },
      level: { long: {}, keyword: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'level');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('[keyword]');
    expect(err?.message).toContain("levelFormat is 'numeric'");
  });

  it('errors when levelFormat:string but field is long-typed', () => {
    const caps = makeCaps(['idx'], {
      '@timestamp': { date: {} },
      'log.level': { long: { type: 'long' } },
      'service.name': { keyword: {} },
      'event.code': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
    const err = report.issues.find((i) => i.field === 'log.level');
    expect(err?.message).toContain("levelFormat is 'string'");
    expect(err?.message).toContain("levelFormat: 'numeric'");
  });

  it('accepts long as valid for levelFormat:numeric', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, MERITT_CAPS);
    expect(report.issues.filter((i) => i.field === 'level')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Service field warnings
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — service field', () => {
  it('warns when service field and keyword sub-field are both absent', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      level: { long: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    // ok may still be true (warning not error)
    const warn = report.issues.find((i) => i.field === 'service_name' || i.field === 'service_name.keyword');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('service_name');
  });

  it('warns when serviceKeyword:true but .keyword sub-field is missing', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      level: { long: {} },
      service_name: { text: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const warn = report.issues.find((i) => i.field === 'service_name.keyword');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('serviceKeyword: false');
  });

  it('no warning when ECS serviceKeyword:false and service.name is keyword-typed', () => {
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, ECS_CAPS);
    const serviceIssues = report.issues.filter((i) => i.field.startsWith('service.name'));
    expect(serviceIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EventCode field warnings
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — eventCode field', () => {
  it('warns when eventCodeKeyword:true but .keyword sub-field is missing', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const warn = report.issues.find((i) => i.field === 'event_code.keyword');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('eventCodeKeyword: false');
  });

  it('no warning when ECS eventCodeKeyword:false and event.code is keyword-typed', () => {
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, ECS_CAPS);
    const ecIssues = report.issues.filter((i) => i.field.startsWith('event.code'));
    expect(ecIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ok flag
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — ok flag', () => {
  it('is false when any error is present, even if warnings are absent', () => {
    const caps = makeCaps(['idx'], {
      level: { long: {} },
      service_name: { text: {} },
      'service_name.keyword': { keyword: {} },
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(false);
  });

  it('is true even when warnings are present (warnings are non-fatal)', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      // service_name.keyword sub-field missing → warning
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// requiresService option — missing service field becomes an error
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — requiresService option', () => {
  const capsNoService = makeCaps(['idx'], {
    time: { date: { type: 'date', searchable: true, aggregatable: true } },
    level: { long: { type: 'long', searchable: true, aggregatable: true } },
    // service_name intentionally absent
    event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
    'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
  });

  it('missing service field is a warning by default (no service filter)', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, capsNoService);
    const svcIssue = report.issues.find((i) => i.field === 'service_name');
    expect(svcIssue?.severity).toBe('warning');
    expect(report.ok).toBe(true);
  });

  it('missing service field becomes an error when requiresService: true', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, capsNoService, {
      requiresService: true,
    });
    const svcIssue = report.issues.find((i) => i.field === 'service_name');
    expect(svcIssue?.severity).toBe('error');
    expect(report.ok).toBe(false);
    expect(svcIssue?.message).toContain('blocked');
  });

  it('missing keyword sub-field on service becomes error when requiresService: true', () => {
    const caps = makeCaps(['idx'], {
      time: { date: {} },
      level: { long: {} },
      service_name: { text: {} },
      // service_name.keyword absent
      event_code: { text: {} },
      'event_code.keyword': { keyword: {} },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps, {
      requiresService: true,
    });
    const svcIssue = report.issues.find((i) => i.field === 'service_name.keyword');
    expect(svcIssue?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });

  it('service field present and keyword ok: no issue regardless of requiresService', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, MERITT_CAPS, {
      requiresService: true,
    });
    const svcIssues = report.issues.filter((i) => i.field.startsWith('service_name'));
    expect(svcIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// requiresEventCode option — missing/non-keyword event-code becomes an error
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — requiresEventCode option', () => {
  const capsNoEcKeyword = makeCaps(['idx'], {
    time: { date: { type: 'date', searchable: true, aggregatable: true } },
    level: { long: { type: 'long', searchable: true, aggregatable: true } },
    service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
    'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    // event_code exists as text only — no keyword sub-field
    event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
  });

  it('missing event-code keyword sub-field is a warning by default', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, capsNoEcKeyword);
    const ecIssue = report.issues.find((i) => i.field === 'event_code.keyword');
    expect(ecIssue?.severity).toBe('warning');
    expect(report.ok).toBe(true);
  });

  it('missing event-code keyword sub-field becomes an error when requiresEventCode: true', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, capsNoEcKeyword, {
      requiresEventCode: true,
    });
    const ecIssue = report.issues.find((i) => i.field === 'event_code.keyword');
    expect(ecIssue?.severity).toBe('error');
    expect(report.ok).toBe(false);
    expect(ecIssue?.message).toContain('blocked');
  });

  it('non-aggregatable base event-code field becomes an error when requiresEventCode: true', () => {
    // eventCodeKeyword: false (ECS-style) but field has no keyword type
    const caps = makeCaps(['idx'], {
      '@timestamp': { date: {} },
      'log.level': { keyword: {} },
      'service.name': { keyword: {} },
      // event.code is text-only — not aggregatable for terms agg
      'event.code': { text: {} },
    });
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, caps, {
      requiresEventCode: true,
    });
    const ecIssue = report.issues.find((i) => i.field === 'event.code');
    expect(ecIssue?.severity).toBe('error');
    expect(report.ok).toBe(false);
    expect(ecIssue?.message).toContain('blocked');
  });

  it('event-code field present and aggregatable: no issue regardless of requiresEventCode', () => {
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, MERITT_CAPS, {
      requiresEventCode: true,
    });
    const ecIssues = report.issues.filter((i) => i.field.startsWith('event_code'));
    expect(ecIssues).toHaveLength(0);
  });

  it('ECS event-code already keyword-typed: no issue when requiresEventCode: true', () => {
    const report = validateMappingAgainstCaps(ECS_FIELD_MAPPING, ECS_CAPS, {
      requiresEventCode: true,
    });
    const ecIssues = report.issues.filter((i) => i.field.startsWith('event.code'));
    expect(ecIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Capability flag checks — searchable / aggregatable
// ---------------------------------------------------------------------------

describe('validateMappingAgainstCaps — capability flags', () => {
  it('errors when timestamp field has correct type but searchable:false', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: false, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const err = report.issues.find((i) => i.field === 'time');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('not searchable');
    expect(report.ok).toBe(false);
  });

  it('errors when level field has correct type but searchable:false', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: false, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const err = report.issues.find((i) => i.field === 'level');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('not searchable');
    expect(report.ok).toBe(false);
  });

  it('errors when service keyword field is not searchable and requiresService:true', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: false, aggregatable: true } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps, { requiresService: true });
    const err = report.issues.find((i) => i.field === 'service_name.keyword');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('not searchable');
    expect(report.ok).toBe(false);
  });

  it('warns when service keyword field is not aggregatable (no requiresServiceAggregation)', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: false } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const warn = report.issues.find((i) => i.field === 'service_name.keyword');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('not aggregatable');
    expect(report.ok).toBe(true);
  });

  it('errors when service keyword field is not aggregatable and requiresServiceAggregation:true', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: false } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps, {
      requiresServiceAggregation: true,
    });
    const err = report.issues.find((i) => i.field === 'service_name.keyword');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('blocked');
    expect(report.ok).toBe(false);
  });

  it('errors when event-code keyword field is not aggregatable and requiresEventCode:true', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: false } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps, { requiresEventCode: true });
    const err = report.issues.find((i) => i.field === 'event_code.keyword');
    expect(err?.severity).toBe('error');
    expect(err?.message).toContain('blocked');
    expect(report.ok).toBe(false);
  });

  it('warns when event-code keyword field is not aggregatable without requiresEventCode', () => {
    const caps = makeCaps(['idx'], {
      time: { date: { type: 'date', searchable: true, aggregatable: true } },
      level: { long: { type: 'long', searchable: true, aggregatable: true } },
      service_name: { text: { type: 'text', searchable: true, aggregatable: false } },
      'service_name.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: true } },
      event_code: { text: { type: 'text', searchable: true, aggregatable: false } },
      'event_code.keyword': { keyword: { type: 'keyword', searchable: true, aggregatable: false } },
    });
    const report = validateMappingAgainstCaps(MERITT_FIELD_MAPPING, caps);
    const warn = report.issues.find((i) => i.field === 'event_code.keyword');
    expect(warn?.severity).toBe('warning');
    expect(warn?.message).toContain('not aggregatable');
    expect(report.ok).toBe(true);
  });
});
