import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeConnectorSecret,
  decryptConnectorSecrets,
  deleteConnectorSecrets,
  isHorusGitignored,
  readLocalSecrets,
  writeLocalConfig,
  localSecretsPath,
} from './discovery.js';
import { resetMasterKeyCache, isEncryptedSecret } from './secrets.js';
import { loadConfig, resolveEnvironment, findPlaintextConnectorSecrets } from './config.js';

const ORIGINAL_ENV = process.env['HORUS_SECRET_KEY'];

describe('encrypted connector-secret storage (HOR-452)', () => {
  let root: string;
  beforeEach(() => {
    process.env['HORUS_SECRET_KEY'] = 'storage-test-key';
    resetMasterKeyCache();
    root = mkdtempSync(join(tmpdir(), 'horus-sec-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env['HORUS_SECRET_KEY'];
    else process.env['HORUS_SECRET_KEY'] = ORIGINAL_ENV;
    resetMasterKeyCache();
  });

  it('writes ciphertext to secrets.local.json, never plaintext', () => {
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'xaat-PLAINTEXT-TOKEN');
    const raw = readFileSync(localSecretsPath(root), 'utf8');
    expect(raw).not.toContain('xaat-PLAINTEXT-TOKEN');
    const stored = readLocalSecrets(root);
    expect(isEncryptedSecret(stored.connectors!['production']!['axiom']!['token'])).toBe(true);
  });

  it('decrypts what it stored', () => {
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'xaat-secret');
    writeConnectorSecret(root, 'production', 'mongodb', 'url', 'mongodb://u:p@h/db');
    const { values, warnings } = decryptConnectorSecrets(root);
    expect(warnings).toEqual([]);
    expect(values['production']!['axiom']!['token']).toBe('xaat-secret');
    expect(values['production']!['mongodb']!['url']).toBe('mongodb://u:p@h/db');
  });

  it('writes the secrets file mode 0600', () => {
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'x');
    const mode = statSync(localSecretsPath(root)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('deleteConnectorSecrets removes one connector', () => {
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'x');
    writeConnectorSecret(root, 'production', 'sentry', 'authToken', 'y');
    deleteConnectorSecrets(root, 'production', 'axiom');
    const { values } = decryptConnectorSecrets(root);
    expect(values['production']?.['axiom']).toBeUndefined();
    expect(values['production']!['sentry']!['authToken']).toBe('y');
  });

  it('a wrong master key is reported as a warning, not a crash', () => {
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'x');
    process.env['HORUS_SECRET_KEY'] = 'a-different-key';
    resetMasterKeyCache();
    const { values, warnings } = decryptConnectorSecrets(root);
    expect(values['production']?.['axiom']).toBeUndefined();
    expect(warnings.join()).toMatch(/axiom\.token/);
  });
});

describe('gitignore status (HOR-452 / F)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'horus-gi-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('non-git directory is treated as ignored (nothing can leak)', () => {
    expect(isHorusGitignored(root)).toBe(true);
  });
  it('git repo with no .gitignore is NOT ignored', () => {
    mkdirSync(join(root, '.git'));
    expect(isHorusGitignored(root)).toBe(false);
  });
  it('git repo that lists .horus/ is ignored', () => {
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.gitignore'), 'node_modules\n.horus/\n');
    expect(isHorusGitignored(root)).toBe(true);
  });
  it('writeConnectorSecret hardens the root .gitignore on a git repo', () => {
    process.env['HORUS_SECRET_KEY'] = 'gi-key';
    resetMasterKeyCache();
    mkdirSync(join(root, '.git'));
    expect(isHorusGitignored(root)).toBe(false);
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'x');
    expect(isHorusGitignored(root)).toBe(true);
    if (ORIGINAL_ENV === undefined) delete process.env['HORUS_SECRET_KEY'];
    else process.env['HORUS_SECRET_KEY'] = ORIGINAL_ENV;
    resetMasterKeyCache();
  });
});

describe('config load hydrates encrypted secrets (HOR-452)', () => {
  let root: string;
  beforeEach(() => {
    process.env['HORUS_SECRET_KEY'] = 'hydrate-key';
    resetMasterKeyCache();
    root = mkdtempSync(join(tmpdir(), 'horus-hyd-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env['HORUS_SECRET_KEY'];
    else process.env['HORUS_SECRET_KEY'] = ORIGINAL_ENV;
    resetMasterKeyCache();
  });

  it('resolveEnvironment sees a decrypted axiom token that is absent from config.json', async () => {
    // config.json carries only the non-secret dataset.
    const configPath = writeLocalConfig(root, {
      version: 1,
      project: {
        name: 'p',
        repositories: [{ name: 'p', path: root }],
        environments: [{ name: 'production', connectors: { axiom: { dataset: 'logs' } } }],
      },
    });
    // The token lives only in the encrypted store.
    writeConnectorSecret(root, 'production', 'axiom', 'token', 'xaat-from-store');

    // config.json must NOT contain the secret.
    expect(readFileSync(configPath, 'utf8')).not.toContain('xaat-from-store');

    const config = await loadConfig(configPath);
    const env = resolveEnvironment(config, { env: 'production' });
    expect(env.connectors.axiom?.dataset).toBe('logs');
    expect(env.connectors.axiom?.token).toBe('xaat-from-store');
  });

  it('does not fabricate a connector block that is absent from config', async () => {
    const configPath = writeLocalConfig(root, {
      version: 1,
      project: {
        name: 'p',
        repositories: [{ name: 'p', path: root }],
        environments: [{ name: 'production', connectors: {} }],
      },
    });
    // A stray secret for a connector not declared in config — must be ignored.
    writeConnectorSecret(root, 'production', 'sentry', 'authToken', 'orphan');
    const config = await loadConfig(configPath);
    const env = resolveEnvironment(config, { env: 'production' });
    expect(env.connectors.sentry).toBeUndefined();
  });
});

describe('findPlaintextConnectorSecrets (HOR-452 migrate/doctor)', () => {
  it('locates plaintext secret fields in a raw project', () => {
    const project = {
      name: 'p',
      environments: [
        {
          name: 'production',
          connectors: {
            axiom: { dataset: 'logs', token: 'xaat-plain' },
            mongodb: { database: 'db', url: 'mongodb://u:p@h/db' },
            sentry: { org: 'o', project: 'pr' }, // no secret present
          },
        },
      ],
    };
    const found = findPlaintextConnectorSecrets(project);
    expect(found).toContain('production/axiom.token');
    expect(found).toContain('production/mongodb.url');
    expect(found).not.toContain('production/sentry.authToken');
  });
});
