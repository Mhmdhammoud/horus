/**
 * Connector-secret encryption at rest (HOR-452).
 *
 * Connector credentials must never live plaintext in `.horus/config.json`. They
 * are AES-256-GCM encrypted into `.horus/secrets.local.json` (gitignored, 0600),
 * and a single 32-byte **master key** — held by the OS, NOT the repo — decrypts
 * them. Encrypting into the already-gitignored secrets file is belt-and-suspenders:
 * the secret is both encrypted AND never committed.
 *
 * Master-key transport, in precedence order (cross-platform, no native modules —
 * everything shells to a platform CLI the way `connect.ts` already does):
 *   1. `HORUS_SECRET_KEY` env var — CI/headless. base64 of 32 bytes is used raw;
 *      anything else is treated as a passphrase and KDF'd (scrypt, fixed salt) so
 *      the same passphrase is deterministic across machines.
 *   2. OS keychain — macOS `security`, Linux `secret-tool` (libsecret),
 *      Windows DPAPI (PowerShell `ConvertFrom/ConvertTo-SecureString`, user-scoped).
 *   3. 0600 key file at `~/.horus/keyring/master.key` — fallback when no keychain
 *      and no env var (e.g. headless Linux with no keyring daemon). Lives in the
 *      home dir, never in the repo. Surfaced with a warning.
 *
 * On the first secret write with none of the above present, a random 32-byte key
 * is generated and persisted to the keychain (or the 0600 file fallback).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** An AES-256-GCM encrypted secret value (all binary fields base64-encoded). */
export interface EncryptedSecret {
  /** Envelope version. */
  v: 1;
  alg: 'aes-256-gcm';
  /** Master-key fingerprint (first 16 hex of sha256(key)) — detects wrong-key decrypts. */
  kid: string;
  /** 12-byte GCM nonce. */
  iv: string;
  /** Ciphertext. */
  ct: string;
  /** 16-byte GCM auth tag. */
  tag: string;
}

/** Where the active master key came from (for `secrets status` / doctor). */
export type MasterKeySource =
  | 'env'
  | 'keychain'
  | 'file'
  | 'generated-keychain'
  | 'generated-file';

export interface MasterKeyResult {
  key: Buffer;
  source: MasterKeySource;
  /** Non-fatal note to surface to the user (e.g. weaker file-fallback storage). */
  warning?: string;
}

/** Thrown when a master key is required for decryption but none can be found. */
export class MasterKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MasterKeyUnavailableError';
  }
}

/** Type guard: is `v` a well-formed EncryptedSecret envelope? */
export function isEncryptedSecret(v: unknown): v is EncryptedSecret {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o['v'] === 1 &&
    o['alg'] === 'aes-256-gcm' &&
    typeof o['kid'] === 'string' &&
    typeof o['iv'] === 'string' &&
    typeof o['ct'] === 'string' &&
    typeof o['tag'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENV_VAR = 'HORUS_SECRET_KEY';
/** Keychain coordinates (macOS service/account, Linux secret-tool attributes). */
const KEY_SERVICE = 'horus';
const KEY_ACCOUNT = 'master-key';
const KEY_LABEL = 'Horus connector-secret master key';
/** Fixed salt so an env passphrase derives the same key on every machine. */
const KDF_SALT = Buffer.from('horus.secret.kdf.v1');
const KEY_BYTES = 32;
const IV_BYTES = 12;
/**
 * Hard ceiling for any keychain CLI call. A locked keychain or a restrictive ACL
 * can make `security`/`secret-tool`/PowerShell block on a GUI prompt that cannot
 * render in a headless/non-interactive shell — without this, the CLI would hang
 * forever. On timeout the call throws and we degrade to the next key source.
 */
const CMD_TIMEOUT_MS = 4000;

let cachedKey: Buffer | null = null;
let cachedSource: MasterKeySource | null = null;

/** Reset the in-process key cache. Test-only; also handy after a rekey. */
export function resetMasterKeyCache(): void {
  cachedKey = null;
  cachedSource = null;
}

// ---------------------------------------------------------------------------
// Key derivation / fingerprint
// ---------------------------------------------------------------------------

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Turn the `HORUS_SECRET_KEY` value into a 32-byte key. A base64 string that
 * decodes to exactly 32 bytes is used verbatim (paste-the-real-key ergonomics);
 * anything else is treated as a passphrase and stretched with scrypt.
 */
function keyFromEnvValue(value: string): Buffer {
  const trimmed = value.trim();
  try {
    const decoded = Buffer.from(trimmed, 'base64');
    if (decoded.length === KEY_BYTES && decoded.toString('base64') === trimmed) {
      return decoded;
    }
  } catch {
    /* fall through to KDF */
  }
  return scryptSync(trimmed, KDF_SALT, KEY_BYTES);
}

// ---------------------------------------------------------------------------
// OS keychain transport (best-effort; any failure → null/false so we degrade)
// ---------------------------------------------------------------------------

function keyringDir(): string {
  return join(homedir(), '.horus', 'keyring');
}
function keyFilePath(): string {
  return join(keyringDir(), 'master.key');
}
function dpapiBlobPath(): string {
  return join(keyringDir(), 'master.key.dpapi');
}

function macKeychainGet(): string | null {
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-s', KEY_SERVICE, '-a', KEY_ACCOUNT, '-w'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: CMD_TIMEOUT_MS },
    );
    const v = out.toString('utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function macKeychainSet(b64: string): boolean {
  try {
    execFileSync(
      'security',
      [
        'add-generic-password',
        '-U', // update if it already exists
        '-s',
        KEY_SERVICE,
        '-a',
        KEY_ACCOUNT,
        '-l',
        KEY_LABEL,
        '-w',
        b64,
      ],
      { stdio: 'ignore', timeout: CMD_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

function linuxKeychainGet(): string | null {
  try {
    const out = execFileSync(
      'secret-tool',
      ['lookup', 'service', KEY_SERVICE, 'account', KEY_ACCOUNT],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: CMD_TIMEOUT_MS },
    );
    const v = out.toString('utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function linuxKeychainSet(b64: string): boolean {
  try {
    execFileSync(
      'secret-tool',
      ['store', '--label', KEY_LABEL, 'service', KEY_SERVICE, 'account', KEY_ACCOUNT],
      { input: b64, stdio: ['pipe', 'ignore', 'ignore'], timeout: CMD_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

function powershellBin(): string | null {
  for (const bin of ['powershell', 'pwsh']) {
    try {
      execFileSync(bin, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
        stdio: 'ignore',
        timeout: CMD_TIMEOUT_MS,
      });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
/** Windows: DPAPI (user-scoped) protect the key to a blob file. Key passed via env, never argv. */
function winKeychainGet(): string | null {
  const ps = powershellBin();
  const blob = dpapiBlobPath();
  if (!ps || !existsSync(blob)) return null;
  const script = `
$enc = Get-Content -Path $env:HORUS_DPAPI_BLOB -Raw
$sec = ConvertTo-SecureString $enc
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }`;
  try {
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, HORUS_DPAPI_BLOB: blob },
    });
    const v = out.toString('utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function winKeychainSet(b64: string): boolean {
  const ps = powershellBin();
  if (!ps) return false;
  mkdirSync(keyringDir(), { recursive: true });
  const blob = dpapiBlobPath();
  const script = `
$sec = ConvertTo-SecureString $env:HORUS_DPAPI_KEY -AsPlainText -Force
$enc = ConvertFrom-SecureString $sec
Set-Content -Path $env:HORUS_DPAPI_BLOB -Value $enc -NoNewline`;
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: CMD_TIMEOUT_MS,
      env: { ...process.env, HORUS_DPAPI_KEY: b64, HORUS_DPAPI_BLOB: blob },
    });
    return true;
  } catch {
    return false;
  }
}

function osKeychainGet(): string | null {
  switch (platform()) {
    case 'darwin':
      return macKeychainGet();
    case 'linux':
      return linuxKeychainGet();
    case 'win32':
      return winKeychainGet();
    default:
      return null;
  }
}
function osKeychainSet(b64: string): boolean {
  switch (platform()) {
    case 'darwin':
      return macKeychainSet(b64);
    case 'linux':
      return linuxKeychainSet(b64);
    case 'win32':
      return winKeychainSet(b64);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// 0600 key-file fallback
// ---------------------------------------------------------------------------

function keyFileGet(): string | null {
  const p = keyFilePath();
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
function keyFileSet(b64: string): boolean {
  try {
    mkdirSync(keyringDir(), { recursive: true });
    const p = keyFilePath();
    writeFileSync(p, b64 + '\n', { mode: 0o600 });
    chmodSync(p, 0o600);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

function cache(key: Buffer, source: MasterKeySource): { key: Buffer; source: MasterKeySource } {
  cachedKey = key;
  cachedSource = source;
  return { key, source };
}

/** Resolve an EXISTING key (env → keychain → file). Does not generate. */
function resolveExistingKey(): { key: Buffer; source: MasterKeySource } | null {
  if (cachedKey && cachedSource) return { key: cachedKey, source: cachedSource };

  const envVal = process.env[ENV_VAR];
  if (envVal && envVal.trim().length > 0) {
    return cache(keyFromEnvValue(envVal), 'env');
  }
  const fromKeychain = osKeychainGet();
  if (fromKeychain) {
    const key = Buffer.from(fromKeychain, 'base64');
    if (key.length === KEY_BYTES) return cache(key, 'keychain');
  }
  const fromFile = keyFileGet();
  if (fromFile) {
    const key = Buffer.from(fromFile, 'base64');
    if (key.length === KEY_BYTES) return cache(key, 'file');
  }
  return null;
}

/**
 * Get the master key for DECRYPTION. Returns null when none is available so
 * callers can degrade (skip hydrating that secret) instead of crashing.
 */
export function getMasterKeyForRead(): Buffer | null {
  return resolveExistingKey()?.key ?? null;
}

/**
 * Get-or-create the master key for ENCRYPTION. Resolves an existing key, or
 * generates a random one and persists it to the keychain (file fallback).
 */
export function ensureMasterKey(): MasterKeyResult {
  const existing = resolveExistingKey();
  if (existing) return { key: existing.key, source: existing.source };

  const key = randomBytes(KEY_BYTES);
  const b64 = key.toString('base64');

  if (osKeychainSet(b64)) {
    cache(key, 'generated-keychain');
    return { key, source: 'generated-keychain' };
  }
  if (keyFileSet(b64)) {
    cache(key, 'generated-file');
    return {
      key,
      source: 'generated-file',
      warning:
        `No OS keychain available — stored the master key at ${keyFilePath()} (mode 0600).\n` +
        `It is in your home directory (never the repo), but is protected only by file permissions.\n` +
        `For stronger isolation set ${ENV_VAR} to a passphrase, or run on a host with a keyring.`,
    };
  }
  throw new MasterKeyUnavailableError(
    `Could not persist a master key (no keychain and ${keyFilePath()} is not writable). ` +
      `Set ${ENV_VAR} to a passphrase and retry.`,
  );
}

/** Human-readable status of the master key for `secrets status` / doctor (never reveals it). */
export function masterKeyStatus(): { available: boolean; source?: MasterKeySource; detail: string } {
  const existing = resolveExistingKey();
  if (!existing) {
    return {
      available: false,
      detail: `no master key yet — one is created on first \`horus connect\` (keychain, or ${ENV_VAR}).`,
    };
  }
  const detail: Record<MasterKeySource, string> = {
    env: `${ENV_VAR} environment variable`,
    keychain: osKeychainLabel(),
    file: `key file ${keyFilePath()} (0600 fallback)`,
    'generated-keychain': osKeychainLabel(),
    'generated-file': `key file ${keyFilePath()} (0600 fallback)`,
  };
  return { available: true, source: existing.source, detail: detail[existing.source] };
}

function osKeychainLabel(): string {
  switch (platform()) {
    case 'darwin':
      return 'macOS Keychain';
    case 'linux':
      return 'libsecret keyring (secret-tool)';
    case 'win32':
      return 'Windows DPAPI (user-scoped)';
    default:
      return 'OS keychain';
  }
}

// ---------------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------------

/** AES-256-GCM encrypt a plaintext secret. Uses the ensured master key by default. */
export function encryptSecret(plaintext: string, key?: Buffer): EncryptedSecret {
  const k = key ?? ensureMasterKey().key;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    kid: fingerprint(k),
    iv: iv.toString('base64'),
    ct: ct.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Decrypt an EncryptedSecret. Throws MasterKeyUnavailableError when no key is
 * present, or a descriptive Error on a key mismatch / tampering.
 */
export function decryptSecret(blob: EncryptedSecret, key?: Buffer): string {
  const k = key ?? getMasterKeyForRead();
  if (!k) {
    throw new MasterKeyUnavailableError(
      `Cannot decrypt: master key not found (set ${ENV_VAR} or restore the OS keychain entry).`,
    );
  }
  if (blob.kid !== fingerprint(k)) {
    throw new Error(
      'Encrypted secret was sealed with a different master key (key fingerprint mismatch). ' +
        `Re-run \`horus connect\` to re-encrypt, or restore the original key.`,
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export { keyFilePath as masterKeyFilePath };
