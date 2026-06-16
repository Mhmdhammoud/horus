/**
 * `horus connect <type>` — add or update a runtime connector in the current
 * repo's `.horus/config.json` (HOR-41).
 *
 * Two modes:
 *  - Flags only (machine-friendly):
 *      horus connect elasticsearch --url https://elastic.meritt.dev \
 *        --username admin --password secret --index-pattern 'logs-*'
 *
 *  - Interactive (human-friendly, kicks in when key flags are missing):
 *      horus connect elasticsearch
 *      > URL: https://elastic.meritt.dev
 *      > Username: admin
 *      > Password: ••••••••
 *      > Index pattern: logs-*
 */

import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import pc from 'picocolors';
import {
  findRepoRoot,
  discoverLocalConfig,
  localConfigPath,
  patchLocalConnector,
  ensureCredentialGitignore,
} from '@horus/core';
import { ElasticsearchClient, MongoStateClient, GrafanaClient } from '@horus/connectors';

export interface ConnectOpts {
  env?: string;
  url?: string;
  username?: string;
  password?: string;
  indexPattern?: string;
  /** Multiple index patterns selected during interactive discovery. */
  indexPatterns?: string[];
  service?: string;
  database?: string;
  collections?: string;
  dashboard?: string;
  /** Multiple dashboard UIDs selected during interactive discovery. */
  dashboardUids?: string[];
  noTest?: boolean;
}

const SUPPORTED = ['elasticsearch', 'mongodb', 'grafana', 'redis'] as const;
type ConnectorType = (typeof SUPPORTED)[number];

export async function runConnect(type: string, opts: ConnectOpts): Promise<number> {
  if (!(SUPPORTED as readonly string[]).includes(type)) {
    console.error(
      pc.red(`Unknown connector type: ${type}`) +
        pc.dim(`\n  supported: ${SUPPORTED.join(', ')}`),
    );
    return 1;
  }
  const connectorType = type as ConnectorType;

  try {
    const cwd = process.cwd();
    const root = findRepoRoot(cwd) ?? cwd;
    const configPath = discoverLocalConfig(cwd) ?? localConfigPath(root);

    // Fill in any missing opts interactively.
    const filled = await fillInteractive(connectorType, opts);

    // Build the patch.
    let patch: Record<string, unknown>;
    switch (connectorType) {
      case 'elasticsearch':
        patch = buildEsPatch(filled);
        break;
      case 'mongodb':
        patch = buildMongoPatch(filled);
        break;
      case 'grafana':
        patch = buildGrafanaPatch(filled);
        break;
      case 'redis':
        patch = buildRedisPatch(filled);
        break;
    }

    // Probe the connector unless --no-test.
    if (!filled.noTest) {
      const probeResult = await probe(connectorType, filled);
      if (!probeResult.ok) {
        console.error(
          `\n${pc.red(`✗ Could not reach ${connectorType}:`)} ${probeResult.detail}` +
            pc.dim('\n  Fix the connection and retry, or pass --no-test to skip.'),
        );
        return 1;
      }
      console.log(`\n${pc.green('✓')} ${connectorType} reachable ${pc.dim(`(${probeResult.detail})`)}`);
    }

    // Guard literal credentials against Git exposure BEFORE writing them.
    const hasLiteralCredentials =
      filled.url !== undefined || filled.password !== undefined || filled.username !== undefined;
    if (hasLiteralCredentials) {
      if (isGitTracked(configPath, root)) {
        console.error(
          pc.red('.horus/config.json is already tracked by Git.') +
            '\nStoring credentials here would expose them in the repository.\n' +
            pc.dim(
              '  Option A — remove from Git index then re-run:\n' +
                '    git rm --cached .horus/config.json\n' +
                '    horus connect ' + type + ' ...\n\n' +
                '  Option B — keep credentials in the environment and reference them:\n' +
                '    export ES_URL=https://...\n' +
                '    export ES_USERNAME=...\n' +
                '    export ES_PASSWORD=...\n' +
                '  Then edit .horus/config.json manually to use urlEnv/usernameEnv/passwordEnv.',
            ),
        );
        return 1;
      }
      // Write the gitignore BEFORE writing credentials so no interval exists
      // where the file contains secrets but is unprotected.
      ensureCredentialGitignore(root);
    }

    // Write to config (writeLocalConfig enforces mode 0600 on every write).
    patchLocalConnector(configPath, connectorType, patch, filled.env);

    console.log(`${pc.green('✓')} ${pc.bold(connectorType)} connector saved → ${pc.dim(configPath)}`);
    printSummary(connectorType, filled);
    console.log(pc.dim(`\n  run: horus investigate "<hint>"`));
    return 0;
  } catch (err) {
    console.error(pc.red((err as Error).message));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Interactive fill-in
// ---------------------------------------------------------------------------

async function fillInteractive(type: ConnectorType, opts: ConnectOpts): Promise<ConnectOpts> {
  const needsInteraction = missingRequired(type, opts);
  if (!needsInteraction) return opts;

  console.log(`\n${pc.bold(`Connect ${type}`)} ${pc.dim('(press Enter to skip optional fields)')}\n`);

  const filled = { ...opts };

  switch (type) {
    case 'elasticsearch':
      filled.url = filled.url ?? (await ask('URL', 'https://elastic.example.com'));
      filled.username = filled.username ?? ((await ask('Username', '', false)) || undefined);
      filled.password =
        filled.password ?? ((await askPassword('Password')) || undefined);
      // Discover available indexes if no index pattern was passed via flag.
      if (filled.indexPattern === undefined && filled.indexPatterns === undefined) {
        const discovered = await discoverEsIndices(filled.url, filled.username, filled.password);
        if (discovered.length > 0) {
          const selected = await askIndexSelection(discovered);
          if (selected.length > 0) {
            filled.indexPatterns = selected;
          }
        }
        // Fall back to manual entry if discovery failed or user typed manually.
        if (filled.indexPatterns === undefined) {
          filled.indexPattern = await ask('Index pattern', 'logs-*');
        }
      }
      filled.service = filled.service ?? ((await ask('Service name', '')) || undefined);
      break;

    case 'mongodb':
      filled.url =
        filled.url ?? (await ask('Connection string', 'mongodb://localhost:27017'));
      filled.database = filled.database ?? (await ask('Database name', ''));
      filled.collections =
        filled.collections ?? ((await ask('Collections (comma-separated, or Enter for all)', '')) || undefined);
      break;

    case 'grafana':
      filled.url = filled.url ?? (await ask('URL', 'https://grafana.example.com'));
      filled.username = filled.username ?? ((await ask('Username', '', false)) || undefined);
      filled.password =
        filled.password ?? ((await askPassword('Password')) || undefined);
      // Discover available dashboards if no dashboard was passed via flag.
      if (filled.dashboard === undefined && filled.dashboardUids === undefined) {
        const discovered = await discoverGrafanaDashboards(filled.url, filled.username, filled.password);
        if (discovered.length > 0) {
          const selected = await askDashboardSelection(discovered);
          if (selected.length > 0) {
            filled.dashboardUids = selected.map((d) => d.uid);
          }
        }
        // Fall back to manual UID entry if discovery failed or user typed manually.
        if (filled.dashboardUids === undefined) {
          filled.dashboard = (await ask('Default dashboard uid', '', false)) || undefined;
        }
      }
      break;

    case 'redis': {
      console.log(
        pc.dim(
          '  Tip: embed credentials directly in the URL — redis://:password@host:6379\n' +
            '       or enter the URL and password separately below.',
        ),
      );
      filled.url = filled.url ?? (await ask('URL', 'redis://localhost:6379'));
      // Only prompt for password when the URL doesn't already contain one.
      if (!redisUrlHasPassword(filled.url)) {
        const pw = (await askPassword('Password')) || undefined;
        if (pw !== undefined && filled.url !== undefined) {
          filled.url = injectRedisPassword(filled.url, pw);
        }
      }
      break;
    }
  }

  return filled;
}

function missingRequired(type: ConnectorType, opts: ConnectOpts): boolean {
  switch (type) {
    case 'elasticsearch':
      return !opts.url || (!opts.indexPattern && !opts.indexPatterns?.length);
    case 'mongodb':
      return !opts.url || !opts.database;
    case 'grafana':
      return !opts.url;
    case 'redis':
      return !opts.url;
  }
}

// ---------------------------------------------------------------------------
// Readline helpers
// ---------------------------------------------------------------------------

function ask(label: string, placeholder = '', required = true): Promise<string> {
  return new Promise((resolve) => {
    const hint = placeholder ? pc.dim(` (${placeholder})`) : '';
    const suffix = required ? '' : pc.dim(' [optional]');
    process.stdout.write(`  ${label}${suffix}${hint}: `);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.once('line', (line) => {
      rl.close();
      resolve(line.trim() || (required ? placeholder : ''));
    });
  });
}

function askPassword(label: string): Promise<string> {
  return new Promise((resolve) => {
    // Use raw mode to mask input character-by-character.
    const stdin = process.stdin;
    if (typeof (stdin as NodeJS.ReadStream).setRawMode === 'function') {
      process.stdout.write(`  ${label}${pc.dim(' [optional]')}: `);
      (stdin as NodeJS.ReadStream).setRawMode(true);
      stdin.resume();
      let value = '';
      const onData = (chunk: Buffer) => {
        const char = chunk.toString();
        if (char === '\r' || char === '\n') {
          (stdin as NodeJS.ReadStream).setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(value);
        } else if (char === '') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '' || char === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          value += char;
          process.stdout.write('•');
        }
      };
      stdin.on('data', onData);
    } else {
      // Non-TTY (piped input): fall back to plain readline.
      resolve(ask(label, '', false));
    }
  });
}

// ---------------------------------------------------------------------------
// Patch builders
// ---------------------------------------------------------------------------

function buildEsPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.indexPattern && !opts.indexPatterns?.length) {
    throw new Error('Index pattern is required for elasticsearch');
  }
  const patch: Record<string, unknown> = {};
  // indexPatterns (array) takes precedence over the legacy indexPattern string.
  if (opts.indexPatterns && opts.indexPatterns.length > 0) {
    patch['indexPatterns'] = opts.indexPatterns;
  } else {
    patch['indexPattern'] = opts.indexPattern;
  }
  if (opts.url) patch['url'] = opts.url;
  if (opts.username) patch['username'] = opts.username;
  if (opts.password) patch['password'] = opts.password;
  if (opts.service) patch['serviceName'] = opts.service;
  return patch;
}

function buildMongoPatch(opts: ConnectOpts): Record<string, unknown> {
  if (!opts.database) throw new Error('Database name is required for mongodb');
  const patch: Record<string, unknown> = { database: opts.database };
  if (opts.url) patch['url'] = opts.url;
  if (opts.collections) {
    patch['collections'] = opts.collections.split(',').map((c) => c.trim()).filter(Boolean);
  }
  return patch;
}

function buildGrafanaPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.url) patch['url'] = opts.url;
  if (opts.username) patch['username'] = opts.username;
  if (opts.password) patch['password'] = opts.password;
  // dashboardUids (array) takes precedence over the legacy dashboard string.
  if (opts.dashboardUids && opts.dashboardUids.length > 0) {
    patch['dashboards'] = opts.dashboardUids;
  } else if (opts.dashboard) {
    patch['dashboard'] = opts.dashboard;
  }
  return patch;
}

function buildRedisPatch(opts: ConnectOpts): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (opts.url) patch['url'] = opts.url;
  return patch;
}

// ---------------------------------------------------------------------------
// Live probe
// ---------------------------------------------------------------------------

interface ProbeResult {
  ok: boolean;
  detail: string;
}

async function probe(type: ConnectorType, opts: ConnectOpts): Promise<ProbeResult> {
  try {
    switch (type) {
      case 'elasticsearch': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const client = new ElasticsearchClient({
          baseUrl: opts.url,
          username: opts.username,
          password: opts.password,
        });
        // AbortController cancels the fetch and clears the timer so nothing
        // keeps the process alive after the probe resolves either way.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('timed out after 8s')), 8000);
        try {
          return await client.health(controller.signal);
        } catch (err) {
          const msg = controller.signal.aborted
            ? 'timed out after 8s'
            : (err as Error).message;
          return { ok: false, detail: msg };
        } finally {
          clearTimeout(timer);
        }
      }
      case 'mongodb': {
        if (!opts.url || !opts.database) return { ok: true, detail: 'skipped (no URL)' };
        // The MongoStateClient already sets serverSelectionTimeoutMS: 5000 in the
        // driver — rely on that for the deadline; just ensure close() runs.
        const client = new MongoStateClient({
          url: opts.url,
          database: opts.database,
          allowlist: opts.collections
            ? opts.collections.split(',').map((c) => c.trim()).filter(Boolean)
            : [],
        });
        try {
          return await client.health();
        } finally {
          await client.close();
        }
      }
      case 'grafana': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (opts.username && opts.password) {
          const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
        const res = await fetch(`${opts.url.replace(/\/$/, '')}/api/health`, {
          headers,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return { ok: true, detail: 'Grafana API reachable' };
        return { ok: false, detail: `HTTP ${res.status}` };
      }
      case 'redis': {
        if (!opts.url) return { ok: true, detail: 'skipped (no URL)' };
        const url = new URL(opts.url);
        const port = parseInt(url.port || '6379', 10);
        const host = url.hostname;
        const reachable = await tcpProbe(host, port);
        return reachable
          ? { ok: true, detail: `TCP ${host}:${port} reachable` }
          : { ok: false, detail: `Could not connect to ${host}:${port}` };
      }
    }
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createConnection } = require('node:net') as typeof import('node:net');
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printSummary(type: ConnectorType, opts: ConnectOpts): void {
  const lines: string[] = [];
  if (opts.url) lines.push(`  url:            ${redactUrl(opts.url)}`);
  if (opts.username) lines.push(`  username:       ${opts.username}`);
  if (opts.password) lines.push(`  password:       ${'•'.repeat(Math.min(opts.password.length, 8))}`);
  if (opts.indexPatterns && opts.indexPatterns.length > 0) {
    lines.push(`  index-patterns: ${opts.indexPatterns.join(', ')}`);
  } else if (opts.indexPattern) {
    lines.push(`  index-pattern:  ${opts.indexPattern}`);
  }
  if (opts.service) lines.push(`  service:        ${opts.service}`);
  if (opts.database) lines.push(`  database:       ${opts.database}`);
  if (opts.collections) lines.push(`  collections:    ${opts.collections}`);
  if (opts.dashboardUids && opts.dashboardUids.length > 0) {
    lines.push(`  dashboards:     ${opts.dashboardUids.join(', ')}`);
  } else if (opts.dashboard) {
    lines.push(`  dashboard:      ${opts.dashboard}`);
  }
  if (lines.length > 0) console.log(pc.dim(lines.join('\n')));
}

/**
 * Return true if `filePath` is currently tracked by Git in the repo at `cwd`.
 * Uses `git ls-files --error-unmatch` which exits non-zero for untracked files.
 * Returns false if Git is unavailable or the path is outside a repository.
 */
function isGitTracked(filePath: string, cwd: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], {
      cwd,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

/** Discover available Elasticsearch index names. Returns [] on any error. */
async function discoverEsIndices(
  url: string | undefined,
  username: string | undefined,
  password: string | undefined,
): Promise<string[]> {
  if (!url) return [];
  try {
    const client = new ElasticsearchClient({ baseUrl: url, username, password });
    const signal = AbortSignal.timeout(8000);
    return await client.listIndices(signal);
  } catch {
    return [];
  }
}

/**
 * Show a numbered list of discovered Elasticsearch indexes and let the user
 * pick one or more by number (comma-separated) or type a pattern manually.
 *
 * Returns the selected index names, or [] if the user skipped / typed manually
 * (the caller falls back to a text prompt in that case).
 */
async function askIndexSelection(indices: string[]): Promise<string[]> {
  const MAX_DISPLAY = 25;
  const shown = indices.slice(0, MAX_DISPLAY);

  console.log('\n  Available Elasticsearch indexes/data streams:');
  shown.forEach((name, i) => {
    console.log(`  ${pc.dim(`[${i + 1}]`)} ${name}`);
  });
  if (indices.length > MAX_DISPLAY) {
    console.log(pc.dim(`  … and ${indices.length - MAX_DISPLAY} more (type a pattern manually to match all)`));
  }

  const input = (await ask(
    `  Select index patterns to use (e.g. 1,2 or Enter to type pattern manually)`,
    '',
    false,
  )).trim();

  if (!input) return [];

  // If the input looks like numbers (e.g. "1,2,3"), parse as selection.
  if (/^[\d,\s]+$/.test(input)) {
    const picks = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < shown.length)
      .map((i) => shown[i] as string);
    if (picks.length > 0) return picks;
  }

  // Non-numeric input: treat as a manually-typed pattern; signal caller to use it.
  // Return a synthetic single-element array so the caller stores it as indexPatterns.
  return [input];
}

/** Discover available Grafana dashboards. Returns [] on any error. */
async function discoverGrafanaDashboards(
  url: string | undefined,
  username: string | undefined,
  password: string | undefined,
): Promise<{ uid: string; title: string; folderTitle?: string }[]> {
  if (!url) return [];
  try {
    const client = new GrafanaClient({ baseUrl: url, username, password });
    const signal = AbortSignal.timeout(8000);
    return await client.searchDashboards(undefined, signal);
  } catch {
    return [];
  }
}

/**
 * Show a numbered list of discovered Grafana dashboards and let the user
 * pick one or more by number. Returns selected dashboard objects, or [] if
 * the user skipped (caller falls back to manual UID prompt).
 */
async function askDashboardSelection(
  dashboards: { uid: string; title: string; folderTitle?: string }[],
): Promise<{ uid: string; title: string }[]> {
  const MAX_DISPLAY = 25;
  const shown = dashboards.slice(0, MAX_DISPLAY);

  console.log('\n  Available Grafana dashboards:');
  shown.forEach((d, i) => {
    const folder = d.folderTitle ? pc.dim(` (${d.folderTitle})`) : '';
    console.log(`  ${pc.dim(`[${i + 1}]`)} ${d.title}${folder}`);
  });
  if (dashboards.length > MAX_DISPLAY) {
    console.log(pc.dim(`  … and ${dashboards.length - MAX_DISPLAY} more`));
  }

  const input = (await ask(
    `  Select dashboards to use (e.g. 1,2 or Enter to type uid manually)`,
    '',
    false,
  )).trim();

  if (!input) return [];

  if (/^[\d,\s]+$/.test(input)) {
    const picks = input
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseInt(s, 10) - 1)
      .filter((i) => i >= 0 && i < shown.length)
      .map((i) => shown[i] as { uid: string; title: string });
    return picks;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Redis credential helpers
// ---------------------------------------------------------------------------

/** Returns true when the Redis URL already has a password in the authority. */
function redisUrlHasPassword(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return new URL(raw).password !== '';
  } catch {
    return false;
  }
}

/**
 * Inject a password into a Redis URL that has no credentials.
 * Produces `redis://:password@host:port/db`.
 */
function injectRedisPassword(raw: string, password: string): string {
  try {
    const u = new URL(raw);
    u.password = encodeURIComponent(password);
    return u.toString();
  } catch {
    // Not parseable — try naive string splice after the scheme
    const match = /^(rediss?:\/\/)(.*)$/.exec(raw);
    if (match?.[1] && match?.[2]) {
      return `${match[1]}:${encodeURIComponent(password)}@${match[2]}`;
    }
    return raw;
  }
}

/** Redact `user:pass@` from a URL before displaying it. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    // Not a valid URL (e.g. a bare hostname) — return as-is; no userinfo to strip.
    return raw;
  }
}
