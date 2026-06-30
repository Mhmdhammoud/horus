import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  encryptSecret,
  decryptSecret,
  isEncryptedSecret,
  resetMasterKeyCache,
  masterKeyStatus,
  getMasterKeyForRead,
  ensureMasterKey,
  MasterKeyUnavailableError,
  type EncryptedSecret,
} from './secrets.js';

/**
 * Drive key resolution through the HORUS_SECRET_KEY env path so tests never touch
 * the real OS keychain. resetMasterKeyCache() clears the in-process cache between
 * key changes.
 */
const ORIGINAL_ENV = process.env['HORUS_SECRET_KEY'];

function useKey(value: string | undefined): void {
  if (value === undefined) delete process.env['HORUS_SECRET_KEY'];
  else process.env['HORUS_SECRET_KEY'] = value;
  resetMasterKeyCache();
}

describe('secrets encryption (HOR-452)', () => {
  beforeEach(() => useKey('test-passphrase-aaaa'));
  afterEach(() => useKey(ORIGINAL_ENV));

  it('round-trips a secret value', () => {
    const blob = encryptSecret('xaat-00d4e547-90c8-4ec0-b1b0-511fecc8458f');
    expect(isEncryptedSecret(blob)).toBe(true);
    expect(blob.alg).toBe('aes-256-gcm');
    expect(blob.ct).not.toContain('xaat'); // ciphertext, not plaintext
    expect(decryptSecret(blob)).toBe('xaat-00d4e547-90c8-4ec0-b1b0-511fecc8458f');
  });

  it('produces a fresh IV per encryption (no deterministic ciphertext)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
    expect(decryptSecret(a)).toBe('same-value');
    expect(decryptSecret(b)).toBe('same-value');
  });

  it('decrypting with a different key fails with a clear fingerprint error', () => {
    const blob = encryptSecret('top-secret');
    useKey('a-totally-different-passphrase');
    expect(() => decryptSecret(blob)).toThrow(/different master key|fingerprint/i);
  });

  it('tampered ciphertext fails the GCM auth tag', () => {
    const blob = encryptSecret('integrity-protected');
    const flipped = Buffer.from(blob.ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    const tampered: EncryptedSecret = { ...blob, ct: flipped.toString('base64') };
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('accepts a base64 32-byte key verbatim', () => {
    const raw = Buffer.alloc(32, 7).toString('base64');
    useKey(raw);
    const blob = encryptSecret('via-raw-key');
    expect(decryptSecret(blob)).toBe('via-raw-key');
  });

  it('the same passphrase decrypts across a cache reset (deterministic KDF)', () => {
    const blob = encryptSecret('persisted');
    useKey('test-passphrase-aaaa'); // same passphrase, cache cleared
    expect(decryptSecret(blob)).toBe('persisted');
  });

  it('masterKeyStatus reports the env source without revealing the key', () => {
    const status = masterKeyStatus();
    expect(status.available).toBe(true);
    expect(status.source).toBe('env');
    expect(status.detail).not.toContain('test-passphrase');
  });

  it('decrypt without any key throws MasterKeyUnavailableError', () => {
    const blob = encryptSecret('needs-a-key');
    useKey(undefined);
    // Only assert when this machine truly has no key source (no env, no keychain
    // entry, no fallback file). On a dev box with a real horus keychain entry the
    // decrypt would instead fail the fingerprint check — so we guard.
    if (getMasterKeyForRead() === null) {
      expect(() => decryptSecret(blob)).toThrow(MasterKeyUnavailableError);
    }
  });

  it('ensureMasterKey reports env source (never generates) when HORUS_SECRET_KEY is set', () => {
    const res = ensureMasterKey();
    expect(res.source).toBe('env');
    expect(res.warning).toBeUndefined();
    // Cached source must survive a status read (regression: cache hardcoded 'env').
    expect(masterKeyStatus().source).toBe('env');
  });

  it('isEncryptedSecret rejects non-envelopes', () => {
    expect(isEncryptedSecret('plain')).toBe(false);
    expect(isEncryptedSecret({ v: 1 })).toBe(false);
    expect(isEncryptedSecret(null)).toBe(false);
  });
});
