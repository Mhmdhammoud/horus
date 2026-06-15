/**
 * Fixture representing real Meritt shared-logger document shapes as observed
 * in live Elasticsearch indices (leadcall-api-prod-*, maison-safqa-prod-new-*).
 *
 * The Meritt logger is pino-based (@meritt/utils Logger). SERVICE_NAME is set
 * from the SERVER_NICKNAME environment variable at startup.
 *
 * No real secrets, credentials, or private payloads are included.
 *
 * Field reference (matches MERITT_FIELD_MAPPING in normalize.ts):
 *   time                – date (ISO-8601); NOT @timestamp
 *   level               – pino numeric long (10=trace 20=debug 30=info 40=warn 50=error 60=fatal)
 *   log_level           – string alias ("error" / "warn" / "info" / "debug")
 *   service_name        – text+keyword; populated from SERVER_NICKNAME env var
 *   message             – text (primary message field)
 *   msg                 – text alias for message (pino native)
 *   log_logger          – component / logger name (text+keyword)
 *   event_code          – structured error/event code (text+keyword)
 *   trace_id            – top-level UUID keyword for request correlation
 *   host_name           – hostname (text+keyword)
 *   service_environment – deployment environment label
 *
 * Index naming convention: {SERVER_NICKNAME}-YYYY-MM-DD
 *   e.g. leadcall-api-prod-2026-06-15
 *        maison-safqa-prod-new-2026-06-15
 */

/** Error-level log document (pino level 50). */
export const MERITT_ERROR_HIT = {
  _index: 'leadcall-api-prod-2026-06-15',
  _id: 'fixture-error-001',
  _source: {
    time: '2026-06-15T01:00:00.000Z',
    level: 50,
    log_level: 'error',
    service_name: 'leadcall-api-prod',
    message: 'Failed to process job: timeout',
    msg: 'Failed to process job: timeout',
    log_logger: 'job-worker',
    event_code: 'JOB_PROCESSING_FAILED',
    trace_id: '11111111-aaaa-bbbb-cccc-000000000001',
    host_name: 'api-worker-01',
    service_environment: 'production',
    err: {
      type: 'Error',
      message: 'Connection timeout after 5000ms',
      stack: 'Error: Connection timeout after 5000ms\n    at processJob (worker.js:42:11)',
    },
  },
} as const;

/** Info-level log document (pino level 30). */
export const MERITT_INFO_HIT = {
  _index: 'leadcall-api-prod-2026-06-15',
  _id: 'fixture-info-001',
  _source: {
    time: '2026-06-15T00:59:00.000Z',
    level: 30,
    log_level: 'info',
    service_name: 'leadcall-api-prod',
    message: 'Job queued successfully',
    log_logger: 'queue-manager',
    event_code: 'JOB_QUEUED',
    trace_id: '11111111-aaaa-bbbb-cccc-000000000002',
    host_name: 'api-worker-01',
    service_environment: 'production',
  },
} as const;

/**
 * Minimal hit using only the pino-native `msg` field (no `message`).
 * Exercises the messageFallbackField path in normalizeHit.
 */
export const MERITT_MSG_ONLY_HIT = {
  _index: 'leadcall-api-prod-2026-06-15',
  _id: 'fixture-msg-only-001',
  _source: {
    time: '2026-06-15T00:58:00.000Z',
    level: 40,
    log_level: 'warn',
    service_name: 'leadcall-api-prod',
    msg: 'Queue depth above threshold',
    event_code: 'QUEUE_DEPTH_WARNING',
    trace_id: '11111111-aaaa-bbbb-cccc-000000000003',
    host_name: 'api-worker-01',
  },
} as const;
