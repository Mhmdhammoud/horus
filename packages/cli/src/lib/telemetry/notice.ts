/**
 * One-time first-run telemetry disclosure (HOR-323, epic HOR-322).
 *
 * Shown once per install, on the first interactive run, regardless of how Horus
 * was installed (npm / homebrew / curl). Printed to stderr so it never pollutes
 * stdout or `--json` output, and only when stderr is a TTY — non-interactive and
 * CI runs are skipped (and will show it on the next interactive run instead).
 *
 * This function must never throw or block: a debugging tool cannot fail because
 * of its own consent banner.
 */
import pc from 'picocolors';
import { loadOrInitTelemetryState, updateTelemetryState } from './store.js';
import { resolveConsent, isCI } from './consent.js';

export const PRIVACY_URL = 'https://horus.sh/privacy';

/** argv tokens for which the banner is suppressed (meta/control commands). */
const SUPPRESS_FIRST_TOKEN = new Set(['telemetry', 'help']);
const SUPPRESS_FLAGS = new Set(['-V', '--version', '-h', '--help']);

function shouldSuppressFor(argv: string[]): boolean {
  const args = argv.slice(2);
  if (args.length === 0) return true; // bare `horus` prints help; don't precede it
  if (args.some((a) => SUPPRESS_FLAGS.has(a))) return true;
  const firstToken = args.find((a) => !a.startsWith('-'));
  return firstToken != null && SUPPRESS_FIRST_TOKEN.has(firstToken);
}

function banner(): string {
  const b = pc.bold;
  const dim = pc.dim;
  return [
    '',
    pc.cyan(b('Horus collects anonymous usage data to improve the tool.')),
    dim('  • On by default: command names, timings, success/failure, and where the'),
    dim('    engine ran out of evidence. No file contents, queries, or secrets.'),
    dim('  • Off by default: your investigation inputs/outputs (opt in to help train'),
    `    ${dim('Horus)')}  ${dim('— run')} ${b('horus telemetry enable-content')}`,
    dim('  • If you use Horus Cloud, linked investigations sync to your workspace.'),
    '',
    `  ${dim('Opt out anytime:')} ${b('horus telemetry disable')}  ${dim('·')}  ${b('HORUS_TELEMETRY=0')}  ${dim('·')}  ${b('DO_NOT_TRACK=1')}`,
    `  ${dim('Details:')} ${pc.underline(PRIVACY_URL)}`,
    '',
  ].join('\n');
}

/**
 * Show the disclosure once, and ensure an install identity + saved preference
 * exist. Safe to call unconditionally at the top of every command run.
 */
export function maybeShowFirstRunNotice(argv: string[] = process.argv): void {
  try {
    const env = process.env;
    // Respect a hard env opt-out: don't create files or print anything.
    if (resolveConsent({ env }).forcedOff) return;
    // Don't write state or nag inside CI/automation; it's noise there.
    if (isCI(env)) return;

    // Ensure the install identity + default preference exist from the first run.
    const state = loadOrInitTelemetryState();
    if (state.tierA.noticeShownAt) return; // already disclosed

    if (shouldSuppressFor(argv)) return;
    // The TTY check is on stderr — our write target — so a redirected/piped
    // stdout or a `--json` consumer is never affected. Non-interactive runs
    // defer the banner to the next interactive run (the file was created above).
    if (!process.stderr.isTTY) return;

    process.stderr.write(banner() + '\n');
    updateTelemetryState((s) => {
      s.tierA.noticeShownAt = new Date().toISOString();
    });
  } catch {
    /* telemetry disclosure must never break the CLI */
  }
}
