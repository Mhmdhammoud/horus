# Elasticsearch field mapping configuration

Horus reads logs from Elasticsearch using a configurable field mapping. The mapping
tells Horus which fields in your index hold the timestamp, log level, service name,
message, trace ID, and error code. Two built-in presets cover the most common shapes:
**Meritt** (pino-based) and **ECS** (Elastic Common Schema).

The mapping is expressed as an `ElasticsearchFieldMapping` TypeScript object passed
to `ElasticsearchLogsProvider` as the `fieldMapping` option. There is no YAML config
layer — examples below show the TypeScript shape.

---

## Configuration fields

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `indexPattern` | string | yes | Elasticsearch index pattern (e.g. `my-service-*`). Wildcard patterns are supported. Passed separately to the provider, not part of `ElasticsearchFieldMapping`. |
| `timestampField` | string | yes | ISO timestamp field used for time-range filtering and sorting. |
| `levelField` | string | yes | Log severity field. |
| `levelFormat` | `"numeric"` \| `"string"` | yes | Whether `levelField` stores pino numeric values (`10/20/30/40/50/60`) or string labels (`debug/info/warn/error/fatal`). |
| `serviceField` | string | yes | Service or application name field. Used for filtering and aggregation. |
| `serviceKeyword` | boolean | yes | Set `true` when `serviceField` is a `text` field with a `.keyword` sub-field. Set `false` when the field is already `keyword`-typed. |
| `messageField` | string | yes | Primary human-readable log message field. |
| `messageFallbackField` | string | no | Secondary message field checked when `messageField` is absent (e.g. pino native `msg`). |
| `traceIdField` | string | no | Top-level trace/correlation ID field (keyword). |
| `requestIdField` | string | no | Top-level HTTP request ID field, when distinct from `traceIdField`. |
| `eventCodeField` | string | yes | Structured event or error code field used for signature aggregations. |
| `eventCodeKeyword` | boolean | yes | Set `true` when `eventCodeField` is `text+keyword`. Set `false` when the field is already `keyword`-typed. |

---

## Level values

Horus maps pino numeric levels to severity buckets using floor division:

| Numeric | String label |
|---------|-------------|
| ≥ 60 | `fatal` |
| ≥ 50 | `error` |
| ≥ 40 | `warn` |
| ≥ 30 | `info` |
| ≥ 20 | `debug` |
| < 20 | `trace` |

When `levelFormat` is `"string"`, Horus applies a `terms` filter with all level
labels at or above the requested minimum. When `levelFormat` is `"numeric"`, Horus
applies a `range: { gte: <value> }` filter against the numeric field.

---

## Built-in presets

### Meritt logger (pino-based)

Used for Meritt shared-logger indices (`leadcall-api-prod-*`, `maison-safqa-prod-new-*`).
The Meritt logger is pino-based (`@meritt/utils Logger`). `SERVICE_NAME` is populated
from the `SERVER_NICKNAME` environment variable at startup.

Index naming convention: `{SERVER_NICKNAME}-YYYY-MM-DD`

```ts
const fieldMapping: ElasticsearchFieldMapping = {
  timestampField: 'time',            // ISO-8601 date — NOT @timestamp
  levelField: 'level',               // pino numeric long (50 = error)
  levelFormat: 'numeric',
  serviceField: 'service_name',      // text+keyword; set from SERVER_NICKNAME
  serviceKeyword: true,              // uses service_name.keyword for term queries
  messageField: 'message',           // primary message field
  messageFallbackField: 'msg',       // pino native fallback
  traceIdField: 'trace_id',          // top-level UUID keyword
  eventCodeField: 'event_code',      // text+keyword error/event code
  eventCodeKeyword: true,            // uses event_code.keyword for aggregations
};
```

Representative document shape:

```json
{
  "time": "2026-06-15T01:00:00.000Z",
  "level": 50,
  "log_level": "error",
  "service_name": "my-service-prod",
  "message": "Failed to process job: timeout",
  "msg": "Failed to process job: timeout",
  "log_logger": "job-worker",
  "event_code": "JOB_PROCESSING_FAILED",
  "trace_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "host_name": "worker-01",
  "service_environment": "production"
}
```

---

### ECS (Elastic Common Schema)

Used with Filebeat, Metricbeat, APM agents, and managed Elastic offerings that
follow ECS conventions. ECS fields may be nested (`service.name`) or pre-flattened
by an ingest pipeline (`"service.name": "api"`). Horus resolves both forms.

```ts
const fieldMapping: ElasticsearchFieldMapping = {
  timestampField: '@timestamp',      // standard ECS date field
  levelField: 'log.level',           // string keyword (e.g. "error")
  levelFormat: 'string',
  serviceField: 'service.name',      // keyword-typed — no .keyword sub-field needed
  serviceKeyword: false,
  messageField: 'message',
  traceIdField: 'trace.id',
  requestIdField: 'http.request.id',
  eventCodeField: 'event.code',      // keyword-typed — no .keyword sub-field needed
  eventCodeKeyword: false,
};
```

---

### Custom / numeric level shape

For indices that store a numeric level but use a non-pino field name:

```ts
const fieldMapping: ElasticsearchFieldMapping = {
  timestampField: '@timestamp',
  levelField: 'severity',            // numeric field, not named 'level'
  levelFormat: 'numeric',
  serviceField: 'app_name',
  serviceKeyword: true,
  messageField: 'log_message',
  eventCodeField: 'error_code',
  eventCodeKeyword: true,
};
```

---

## Failure modes

### Wrong `levelFormat`

**Symptom:** Horus returns no error-level logs even though errors are visible in
Kibana, or filters at the wrong severity.

**Cause:** `levelFormat: "string"` with a numeric field (or vice versa). Horus
uses a `range` filter for numeric and a `terms` filter for string. A string `terms`
filter on a numeric field (`{ terms: { level: ["error", "warn"] } }`) matches
nothing in Elasticsearch.

**Fix:** Set `levelFormat: "numeric"` for pino-style indices. Set `levelFormat: "string"`
for string-typed level fields.

---

### Wrong `serviceKeyword`

**Symptom:** Service filter queries return no results, or Elasticsearch rejects the
aggregation with "field is not aggregatable."

**Cause:** If `serviceKeyword: true` but the index has no `service_name.keyword`
sub-field, term queries fail silently. If `serviceKeyword: false` but the field is
a raw `text` type, aggregations may be rejected.

**Fix:** Set `serviceKeyword: true` only when the service field has a `.keyword`
mapping (typical for `text+keyword` fields). Set `serviceKeyword: false` when the
field is already `keyword`-typed (typical for ECS `service.name`).

---

### Wrong `timestampField`

**Symptom:** All time-range queries return no results. Horus shows "Index matched
no documents in range."

**Cause:** The timestamp field name does not match what is actually indexed. Common
mismatch: using `@timestamp` for a Meritt/pino index that stores timestamps in `time`.

**Fix:** Confirm the field name in Kibana's index pattern or via the
`GET my-index-*/_field_caps?fields=*` API. Set `timestampField` to the exact
field name.

---

### Index pattern matched no indices

**Symptom:** Horus reports "Index pattern matched no indices. Horus will find no
evidence."

**Cause:** The `indexPattern` value does not match any existing index. Common
causes: wrong environment suffix (`-prod-*` vs `-staging-*`), wrong date format in
rolling index names, or the index has not been created yet.

**Fix:** Verify the pattern with `GET _cat/indices/<indexPattern>?v` in Kibana Dev
Tools.

---

### Missing `eventCodeField` / `eventCodeKeyword` mismatch

**Symptom:** Error signature aggregations return no buckets even though matching
error documents exist. Downstream investigation shows "no matching logs" despite
evidence to the contrary.

**Cause:** `eventCodeKeyword: true` but `event_code.keyword` does not exist in the
mapping, so the `terms` aggregation targets a missing field and returns empty buckets.

**Fix:** Confirm the keyword sub-field exists in the index mapping. If the field is
already `keyword`-typed, set `eventCodeKeyword: false`.
