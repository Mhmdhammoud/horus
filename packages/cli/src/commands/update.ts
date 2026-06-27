import {
  writeFileSync,
  unlinkSync,
  renameSync,
  existsSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { HORUS_VERSION, PINNED_SOURCE_VERSION } from '@horus/core';
import { getSourceVersion } from '@horus/connectors';

const execFileAsync = promisify(execFile);

/**
 * Keep the source-intelligence backend in lockstep with the CLI (HOR-350). A CLI that is
 * newer than its pinned `horus-source` builds a graph it cannot map (and refuses to index),
 * so after updating the CLI we bring the backend to {@link PINNED_SOURCE_VERSION} too. The
 * backend is installed via `uv tool` (see install.sh), so we upgrade the same way. Best-effort:
 * never fails the update — falls back to pointing at the installer.
 */
async function ensureBackendPinned(write: (line: string) => void): Promise<void> {
  let installed: string | null = null;
  try {
    installed = await getSourceVersion();
  } catch {
    installed = null;
  }
  if (installed === PINNED_SOURCE_VERSION) {
    write(`  ${pc.green('✓')} Source backend already on pinned ${PINNED_SOURCE_VERSION}.`);
    return;
  }
  if (installed === null) {
    write(
      `  ${pc.dim('Source backend not installed — install it: curl -fsSL https://horus.sh/install.sh | bash')}`,
    );
    return;
  }
  write(`  Upgrading source backend ${installed} → ${PINNED_SOURCE_VERSION}…`);
  try {
    await execFileAsync(
      'uv',
      // --refresh: a CLI update commonly lands seconds after a backend release, so uv's
      // cached PyPI index may not list the just-published version yet and the install
      // resolves to "unsatisfiable". Refreshing the index makes the lockstep upgrade
      // reliable right after a release (HOR-360).
      ['tool', 'install', '--force', '--refresh', `horus-source==${PINNED_SOURCE_VERSION}`],
      { timeout: 300_000 },
    );
    write(`  ${pc.green('✓')} Source backend upgraded to ${PINNED_SOURCE_VERSION}.`);
  } catch {
    write(`  ${pc.yellow('!')} Couldn't auto-upgrade the source backend. Re-run the installer:`);
    write(`    ${pc.dim('curl -fsSL https://horus.sh/install.sh | bash')}`);
  }
}

const RELEASES_API = 'https://api.github.com/repos/meritt-dev/horus/releases/latest';

interface GitHubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

export function parseVersion(v: string): [number, number, number] {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Cannot parse version: ${v}`);
  return [+m[1]!, +m[2]!, +m[3]!];
}

export function isNewer(candidate: string, current: string): boolean {
  const [cam, can, cap] = parseVersion(candidate);
  const [cum, cun, cup] = parseVersion(current);
  if (cam !== cum) return cam > cum;
  if (can !== cun) return can > cun;
  return cap > cup;
}

async function fetchLatestRelease(
  _fetch = fetch,
): Promise<GitHubRelease> {
  const res = await _fetch(RELEASES_API, {
    headers: {
      'User-Agent': `horus/${HORUS_VERSION}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);
  return res.json() as Promise<GitHubRelease>;
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function resolveBinaryPath(): string {
  const raw = process.argv[1];
  if (!raw) throw new Error('Cannot determine binary path from process.argv[1]');
  try {
    return realpathSync(raw);
  } catch {
    return raw;
  }
}

export async function runUpdate(opts: {
  check?: boolean;
  force?: boolean;
  write?: (line: string) => void;
  _fetch?: typeof fetch;
  /** Injectable for tests — defaults to the build-time HORUS_VERSION. */
  _currentVersion?: string;
}): Promise<number> {
  const write = opts.write ?? ((l: string) => console.log(l));
  const _fetch = opts._fetch ?? fetch;
  const currentVersion = opts._currentVersion ?? HORUS_VERSION;

  write(`\n${pc.bold('Horus update')}\n`);
  write(`  Current version: ${pc.cyan(currentVersion)}`);

  let release: GitHubRelease;
  try {
    release = await fetchLatestRelease(_fetch);
  } catch (e) {
    write(`  ${pc.red('✗')} Could not reach GitHub: ${(e as Error).message}`);
    return 1;
  }

  const latest = release.tag_name.replace(/^v/, '');
  write(`  Latest version:  ${pc.cyan(latest)}`);

  const newer = isNewer(latest, currentVersion);

  if (opts.check) {
    if (newer) {
      write(`\n  ${pc.yellow('→')} ${pc.bold(latest)} is available.`);
      write(`    Run ${pc.bold('horus update')} to upgrade.`);
    } else {
      write(`\n  ${pc.green('✓')} Already on the latest version.`);
    }
    return 0;
  }

  if (!newer && !opts.force) {
    write(`\n  ${pc.green('✓')} Already on the latest version.`);
    // Even when the CLI is current, the backend can have drifted — keep it pinned.
    await ensureBackendPinned(write);
    return 0;
  }

  const tag = release.tag_name;
  const assetName = `horus-${tag}`;
  const checksumName = `${assetName}.sha256`;

  const binaryAsset = release.assets.find(a => a.name === assetName);
  const checksumAsset = release.assets.find(a => a.name === checksumName);

  if (!binaryAsset) {
    write(`  ${pc.red('✗')} Release ${tag} has no binary asset named '${assetName}'.`);
    write(`    Fallback: ${pc.dim('curl -fsSL https://horus.sh/install.sh | bash')}`);
    return 1;
  }

  write(`\n  Downloading ${assetName}...`);
  const binRes = await _fetch(binaryAsset.browser_download_url, {
    headers: { 'User-Agent': `horus/${HORUS_VERSION}` },
    redirect: 'follow',
  });
  if (!binRes.ok || !binRes.body) {
    write(`  ${pc.red('✗')} Download failed: ${binRes.status}`);
    return 1;
  }
  const binBuf = Buffer.from(await binRes.arrayBuffer());

  if (checksumAsset) {
    const csRes = await _fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': `horus/${HORUS_VERSION}` },
      redirect: 'follow',
    });
    if (csRes.ok) {
      const csText = await csRes.text();
      const expectedHash = csText.trim().split(/\s+/)[0]!;
      const actualHash = sha256hex(binBuf);
      if (expectedHash !== actualHash) {
        write(`  ${pc.red('✗')} Checksum mismatch — download may be corrupt.`);
        write(`    Expected: ${expectedHash}`);
        write(`    Got:      ${actualHash}`);
        return 1;
      }
      write(`  ${pc.green('✓')} Checksum verified.`);
    }
  }

  let binaryPath: string;
  try {
    binaryPath = resolveBinaryPath();
  } catch (e) {
    write(`  ${pc.red('✗')} ${(e as Error).message}`);
    return 1;
  }

  if (!existsSync(binaryPath)) {
    write(`  ${pc.red('✗')} Binary not found at ${binaryPath}`);
    return 1;
  }

  const tmpPath = join(tmpdir(), `horus-update-${tag}-${process.pid}`);
  const backupPath = `${binaryPath}.bak`;

  try {
    writeFileSync(tmpPath, binBuf, { mode: 0o755 });
  } catch (e) {
    write(`  ${pc.red('✗')} Could not write to temp dir: ${(e as Error).message}`);
    return 1;
  }

  try {
    renameSync(binaryPath, backupPath);
    try {
      renameSync(tmpPath, binaryPath);
      chmodSync(binaryPath, 0o755);
    } catch (e) {
      // Rollback: restore backup
      try { renameSync(backupPath, binaryPath); } catch { /* ignore */ }
      throw e;
    }
    try { unlinkSync(backupPath); } catch { /* backup removal is best-effort */ }
  } catch (e) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    const msg = (e as NodeJS.ErrnoException).message ?? String(e);
    const needsSudo = (e as NodeJS.ErrnoException).code === 'EACCES'
      || (e as NodeJS.ErrnoException).code === 'EPERM';
    write(`  ${pc.red('✗')} Could not replace binary at ${binaryPath}: ${msg}`);
    if (needsSudo) {
      write(`\n  Try with sudo:`);
      write(
        `    ${pc.dim(`sudo curl -fsSL https://github.com/meritt-dev/horus/releases/download/${tag}/${assetName} -o ${binaryPath} && sudo chmod +x ${binaryPath}`)}`,
      );
    }
    return 1;
  }

  write(`  ${pc.green('✓')} Updated: ${pc.bold(currentVersion)} → ${pc.bold(latest)}`);
  write(`  ${pc.dim(binaryPath)}`);
  // Bring the source backend to the version this new CLI is pinned to (HOR-350).
  await ensureBackendPinned(write);
  return 0;
}
