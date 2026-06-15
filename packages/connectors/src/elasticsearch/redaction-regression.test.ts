/**
 * HOR-109 — Runtime evidence redaction regression tests.
 *
 * Proves that sensitive values (authorization headers, cookies, passwords,
 * API keys, database URLs, token-like values) are stripped from runtime
 * evidence before it reaches reports, saved packets, postmortems, or AI
 * narrative input.
 *
 * All fixtures use synthetic/fake values only. No real credentials here.
 */

import { describe, it, expect } from 'vitest';
import {
  redactSensitiveString,
  redactErrorSignature,
  analysisToEvidence,
} from './analyze.js';
import type { ErrorSignature, LogAnalysis } from './analyze.js';
import { ElasticsearchClient } from './client.js';
import { ElasticsearchLogsProvider } from './provider.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sig(sampleMessage: string): ErrorSignature {
  return {
    key: 'TEST001',
    count: 1,
    firstSeen: '2026-06-15T10:00:00Z',
    lastSeen: '2026-06-15T10:01:00Z',
    services: ['test-api'],
    sampleMessage,
  };
}

function analysis(sampleMessage: string): LogAnalysis {
  return {
    window: { from: '2026-06-15T09:00:00Z', to: '2026-06-15T10:00:00Z' },
    totalErrors: 1,
    signatures: [sig(sampleMessage)],
    newSignatures: [],
    affectedServices: ['test-api'],
  };
}

function mockResponse(message: string, sigKey = 'LEAK001') {
  return {
    hits: { total: { value: 1 } },
    aggregations: {
      by_sig: {
        buckets: [
          {
            key: sigKey,
            doc_count: 1,
            first_seen: { value_as_string: '2026-06-15T10:00:00Z' },
            last_seen: { value_as_string: '2026-06-15T10:00:01Z' },
            services: { buckets: [] },
            sample: { hits: { hits: [{ _source: { message } }] } },
          },
        ],
      },
      affected_services: { buckets: [] },
    },
  };
}

const EMPTY = {
  hits: { total: { value: 0 } },
  aggregations: { by_sig: { buckets: [] }, affected_services: { buckets: [] } },
};

function makeProvider(...responses: unknown[]): ElasticsearchLogsProvider {
  const client = new ElasticsearchClient({ baseUrl: 'http://mock' });
  let idx = 0;
  client.search = async () => responses[idx++] ?? {};
  return new ElasticsearchLogsProvider(client, { indexPattern: 'test-*' });
}

const NOW = '2026-06-15T10:05:00Z';

// ---------------------------------------------------------------------------
// 1. Authorization headers
// ---------------------------------------------------------------------------

describe('redactSensitiveString — authorization headers', () => {
  it('redacts Bearer token value', () => {
    const result = redactSensitiveString('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts Basic auth token value', () => {
    const result = redactSensitiveString('Authorization: Basic dXNlcjpzZWNyZXQ=');
    expect(result).not.toContain('dXNlcjpzZWNyZXQ=');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves the Authorization header name after redaction', () => {
    const result = redactSensitiveString('Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload');
    expect(result.toLowerCase()).toContain('authorization');
  });
});

// ---------------------------------------------------------------------------
// 2. Cookie headers
// ---------------------------------------------------------------------------

describe('redactSensitiveString — cookie headers', () => {
  it('redacts Cookie header values', () => {
    const result = redactSensitiveString('Request failed: Cookie: session_id=abc123xyz_secret');
    expect(result).not.toContain('abc123xyz_secret');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts set-cookie header values', () => {
    const result = redactSensitiveString('set-cookie: auth_token=eyJhbGciOiJSUzI1NiJ9secret');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9secret');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves the cookie key name after redaction', () => {
    const result = redactSensitiveString('Cookie: session=supersecretSessionValue123');
    expect(result.toLowerCase()).toContain('cookie');
  });

  it('does not redact short cookie values (fewer than 4 chars — not a secret)', () => {
    const msg = 'Cookie: x=1';
    expect(redactSensitiveString(msg)).toBe(msg);
  });
});

// ---------------------------------------------------------------------------
// 3. Passwords, API keys, secrets
// ---------------------------------------------------------------------------

describe('redactSensitiveString — passwords, API keys, secrets', () => {
  it('redacts password= key-value patterns', () => {
    const result = redactSensitiveString('Connection rejected: password=SuperSecret123!');
    expect(result).not.toContain('SuperSecret123!');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts api_key= patterns', () => {
    const result = redactSensitiveString('Rejected: api_key=sk-abcXYZ1234567890');
    expect(result).not.toContain('sk-abcXYZ1234567890');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts x-api-key header values', () => {
    const result = redactSensitiveString('x-api-key: super_secret_api_key_value');
    expect(result).not.toContain('super_secret_api_key_value');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts secret= patterns', () => {
    const result = redactSensitiveString('secret=abc123XYZ_private_value');
    expect(result).not.toContain('abc123XYZ_private_value');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts JSON "token" field values', () => {
    const result = redactSensitiveString('payload: {"token": "ghp_abcdefABCDEF1234567890"}');
    expect(result).not.toContain('ghp_abcdefABCDEF1234567890');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves the key name while redacting the value', () => {
    const result = redactSensitiveString('password=hunter2');
    expect(result).toContain('password');
    expect(result).not.toContain('hunter2');
  });
});

// ---------------------------------------------------------------------------
// 4. Database / service connection-string URLs
// ---------------------------------------------------------------------------

describe('redactSensitiveString — database URLs', () => {
  it('redacts credentials in postgresql:// URLs', () => {
    const result = redactSensitiveString(
      'Failed to connect: postgresql://dbuser:secret_pass@pg.internal:5432/mydb',
    );
    expect(result).not.toContain('secret_pass');
    expect(result).not.toContain('dbuser');
    expect(result).toContain('postgresql://');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts credentials in mongodb:// URLs', () => {
    const result = redactSensitiveString(
      'MongoError: mongodb://mongouser:mongosecret@mongo.internal:27017/proddb',
    );
    expect(result).not.toContain('mongosecret');
    expect(result).not.toContain('mongouser');
    expect(result).toContain('[REDACTED]');
  });

  it('redacts credentials in redis:// URLs', () => {
    const result = redactSensitiveString(
      'RedisError: redis://redisuser:redissecret@redis.internal:6379',
    );
    expect(result).not.toContain('redissecret');
    expect(result).toContain('[REDACTED]');
  });

  it('preserves the database host and port after credential redaction', () => {
    const result = redactSensitiveString(
      'postgresql://dbuser:secret_pass@pg.internal:5432/mydb',
    );
    expect(result).toContain('pg.internal:5432');
  });

  it('leaves connection strings without credentials unchanged', () => {
    const clean = 'postgresql://pg.internal:5432/mydb';
    expect(redactSensitiveString(clean)).toBe(clean);
  });
});

// ---------------------------------------------------------------------------
// 5. Card numbers (PCI)
// ---------------------------------------------------------------------------

describe('redactSensitiveString — card numbers', () => {
  it('redacts 16-digit card numbers with spaces', () => {
    const result = redactSensitiveString('Payment failed for card 4111 1111 1111 1111');
    expect(result).not.toContain('4111 1111 1111 1111');
    expect(result).toContain('[REDACTED-CARD]');
  });

  it('redacts compact 16-digit card numbers', () => {
    const result = redactSensitiveString('card 5500000000000004 declined');
    expect(result).not.toContain('5500000000000004');
    expect(result).toContain('[REDACTED-CARD]');
  });
});

// ---------------------------------------------------------------------------
// 6. Multiple sensitive patterns in a single string
// ---------------------------------------------------------------------------

describe('redactSensitiveString — multiple patterns in one string', () => {
  it('redacts both Authorization Bearer token and password in the same message', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.secret | fallback: password=hunter2';
    const result = redactSensitiveString(input);
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(result).not.toContain('hunter2');
  });

  it('redacts cookie and api_key in the same message', () => {
    const input = 'Cookie: session=abc123secretsession api_key=sk-superSecretKey1234';
    const result = redactSensitiveString(input);
    expect(result).not.toContain('abc123secretsession');
    expect(result).not.toContain('sk-superSecretKey1234');
  });
});

// ---------------------------------------------------------------------------
// 7. Benign strings — must not be altered
// ---------------------------------------------------------------------------

describe('redactSensitiveString — benign strings preserved', () => {
  it('leaves ordinary queue-stall messages unchanged', () => {
    const msg = 'Queue depth reached 1200, stall detected after 30000ms';
    expect(redactSensitiveString(msg)).toBe(msg);
  });

  it('leaves service names unchanged', () => {
    const msg = 'leadcall-api failed to process job id=42';
    expect(redactSensitiveString(msg)).toBe(msg);
  });

  it('leaves database URLs without embedded credentials unchanged', () => {
    const url = 'postgresql://pg.internal:5432/mydb';
    expect(redactSensitiveString(url)).toBe(url);
  });

  it('leaves empty string unchanged', () => {
    expect(redactSensitiveString('')).toBe('');
  });

  it('does not redact the word "token" in a service description', () => {
    const msg = 'token refresh rate: 3 per second';
    // "token" by itself with short trailing value is fine; the word "token"
    // followed by digits below the 4-char minimum must not be destroyed.
    const result = redactSensitiveString(msg);
    expect(result).toContain('token');
  });
});

// ---------------------------------------------------------------------------
// 8. redactErrorSignature — sampleMessage path
// ---------------------------------------------------------------------------

describe('redactErrorSignature — sampleMessage redaction', () => {
  it('redacts Bearer token from sampleMessage', () => {
    const s = sig('Request failed: Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.payload');
    const redacted = redactErrorSignature(s);
    expect(redacted.sampleMessage).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(redacted.sampleMessage).toContain('[REDACTED]');
  });

  it('redacts postgresql:// credentials from sampleMessage', () => {
    const s = sig('DB error: postgresql://admin:secretpass@pg.internal:5432/prod');
    const redacted = redactErrorSignature(s);
    expect(redacted.sampleMessage).not.toContain('secretpass');
    expect(redacted.sampleMessage).toContain('[REDACTED]');
  });

  it('redacts cookie value from sampleMessage', () => {
    const s = sig('Upstream error: Cookie: session=supersecretSessionValue123');
    const redacted = redactErrorSignature(s);
    expect(redacted.sampleMessage).not.toContain('supersecretSessionValue123');
    expect(redacted.sampleMessage).toContain('[REDACTED]');
  });

  it('does not mutate the original signature object', () => {
    const original = 'token=sensitive_value_here';
    const s = sig(original);
    redactErrorSignature(s);
    expect(s.sampleMessage).toBe(original);
  });

  it('preserves all non-sampleMessage fields', () => {
    const s = sig('password=hunter2');
    const redacted = redactErrorSignature(s);
    expect(redacted.key).toBe('TEST001');
    expect(redacted.count).toBe(1);
    expect(redacted.services).toEqual(['test-api']);
  });

  it('returns the original object unchanged when sampleMessage is undefined', () => {
    const s: ErrorSignature = { key: 'X', count: 1, firstSeen: '', lastSeen: '', services: [] };
    expect(redactErrorSignature(s)).toBe(s);
  });
});

// ---------------------------------------------------------------------------
// 9. Full pipeline via queryEvidence — sensitive payload does not escape
// ---------------------------------------------------------------------------

describe('queryEvidence — redaction pipeline', () => {
  it('redacts Bearer token from sampleMessage payload via queryEvidence', async () => {
    const provider = makeProvider(
      mockResponse('Auth failed: Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.secret'),
      EMPTY,
    );
    const evidence = await provider.queryEvidence({}, NOW);
    const payload = evidence[0]!.payload as Record<string, unknown>;
    const msg = payload['sampleMessage'] as string;
    expect(msg).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(msg).toContain('[REDACTED]');
  });

  it('redacts Cookie header value from sampleMessage payload via queryEvidence', async () => {
    const provider = makeProvider(
      mockResponse('Request: Cookie: session_id=supersecretSessionToken123'),
      EMPTY,
    );
    const evidence = await provider.queryEvidence({}, NOW);
    const payload = evidence[0]!.payload as Record<string, unknown>;
    const msg = payload['sampleMessage'] as string;
    expect(msg).not.toContain('supersecretSessionToken123');
    expect(msg).toContain('[REDACTED]');
  });

  it('redacts database URL credentials from sampleMessage payload via queryEvidence', async () => {
    const provider = makeProvider(
      mockResponse('DB panic: postgresql://dbuser:dbsecret@pg.internal:5432/prod'),
      EMPTY,
    );
    const evidence = await provider.queryEvidence({}, NOW);
    const payload = evidence[0]!.payload as Record<string, unknown>;
    const msg = payload['sampleMessage'] as string;
    expect(msg).not.toContain('dbsecret');
    expect(msg).not.toContain('dbuser');
    expect(msg).toContain('[REDACTED]');
  });

  it('evidence title does not contain sampleMessage content (only signature key/count)', async () => {
    const provider = makeProvider(
      mockResponse('password=hunter2 caused auth failure', 'AUTH003'),
      EMPTY,
    );
    const evidence = await provider.queryEvidence({}, NOW);
    const sigEv = evidence.find(
      (e) => (e.payload as Record<string, unknown>)?.['key'] === 'AUTH003',
    );
    // title is built from signature key + count + timestamps, not from sampleMessage
    expect(sigEv!.title).toContain('AUTH003');
    expect(sigEv!.title).not.toContain('hunter2');
    expect(sigEv!.title).not.toContain('password');
  });
});
