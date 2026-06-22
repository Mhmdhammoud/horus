import { describe, it, expect } from 'vitest';
import { redactSecrets, redactContent, redactOrDrop } from './redact.js';

describe('redactSecrets (conservative — ES log behavior)', () => {
  it('redacts bearer tokens, secret KV, conn-string creds, and card numbers', () => {
    expect(redactSecrets('Authorization: Bearer abc.def.ghi')).toContain('[REDACTED]');
    expect(redactSecrets('password=hunter2 other=ok')).toBe('password=[REDACTED] other=ok');
    expect(redactSecrets('postgres://user:secret@host:5432/db')).toBe(
      'postgres://[REDACTED]@host:5432/db',
    );
    expect(redactSecrets('card 4111 1111 1111 1111 end')).toContain('[REDACTED-CARD]');
  });

  it('does NOT touch emails or IPs (stays conservative for log evidence)', () => {
    expect(redactSecrets('contact a@b.com from 10.0.0.1')).toBe('contact a@b.com from 10.0.0.1');
  });

  it('leaves ordinary text unchanged', () => {
    expect(redactSecrets('checkout latency spiked on the scheduler')).toBe(
      'checkout latency spiked on the scheduler',
    );
  });
});

describe('redactContent (aggressive — content leaving the machine)', () => {
  it('redacts emails and IPs', () => {
    const out = redactContent('user jane@acme.io at 192.168.1.20');
    expect(out).toContain('[REDACTED-EMAIL]');
    expect(out).toContain('[REDACTED-IP]');
    expect(out).not.toContain('jane@acme.io');
  });

  it('redacts JWTs, AWS keys, GCP keys, Slack/GitHub tokens, and private keys', () => {
    expect(redactContent('tok eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJ end')).toContain('[REDACTED-JWT]');
    expect(redactContent('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED-AWS-KEY]');
    expect(redactContent('AIza' + 'a'.repeat(35))).toContain('[REDACTED-GCP-KEY]');
    // Assembled from parts so no real secret-shaped literal lives in source — keeps
    // secret scanning / push protection happy while feeding the redactor the same input.
    const slackToken = ['xoxb', '123456789012', 'abcdefghijklmnop'].join('-');
    expect(redactContent(`tok ${slackToken}`)).toContain('[REDACTED-SLACK-TOKEN]');
    const ghToken = 'ghp_' + '0123456789abcdefghijklmnopqrstuvwxyz12';
    expect(redactContent(ghToken)).toContain('[REDACTED-GH-TOKEN]');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----';
    expect(redactContent(`key: ${pem}`)).toContain('[REDACTED-PRIVATE-KEY]');
  });

  it('also applies the conservative base patterns', () => {
    expect(redactContent('password=hunter2')).toBe('password=[REDACTED]');
  });
});

describe('redactOrDrop (fail-closed)', () => {
  it('returns the scrubbed value for normal content', () => {
    const r = redactOrDrop('investigate checkout latency for jane@acme.io');
    expect(r.dropped).toBe(false);
    expect(r.value).toContain('[REDACTED-EMAIL]');
    expect(r.value).not.toContain('jane@acme.io');
  });

  it('does not leak a high-risk secret in the returned value', () => {
    const r = redactOrDrop('here is a token AKIAIOSFODNN7EXAMPLE and a jwt eyJa.eyJb.cccc');
    expect(r.dropped).toBe(false);
    expect(r.value).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(r.value).not.toMatch(/eyJa\.eyJb\.cccc/);
  });
});
