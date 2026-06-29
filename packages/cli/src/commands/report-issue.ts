/**
 * `horus report [hint]` (HOR-439) — file a bug / capability gap against Horus.
 *
 * Builds a PRE-FILLED GitHub issue URL on meritt-dev/horus (title + markdown body with an
 * Environment block) and best-effort opens it in the browser. NO auth, NO API call, NO dedup,
 * NO auto-implementor — this is a low-friction "tell us what's broken/missing" affordance. The
 * URL is ALWAYS printed so it works on a headless box / when no browser is available.
 *
 * The issue-builder is shared with the `report_issue` MCP tool so an agent that detects a Horus
 * gap mid-task can produce the exact same pre-filled URL.
 */
import pc from 'picocolors';
import { HORUS_VERSION, PINNED_SOURCE_VERSION } from '@horus/core';
import { openBrowser } from '../lib/open-url.js';

const ISSUE_BASE = 'https://github.com/meritt-dev/horus/issues/new';

export interface IssueEnvironment {
  horusVersion: string;
  sourceVersion: string;
  platform: string;
  nodeVersion: string;
}

export interface BuiltIssue {
  url: string;
  title: string;
  body: string;
  labels: string[];
  environment: IssueEnvironment;
}

/** Snapshot the runtime environment that rides on every reported issue. */
export function issueEnvironment(): IssueEnvironment {
  return {
    horusVersion: HORUS_VERSION,
    sourceVersion: PINNED_SOURCE_VERSION,
    platform: process.platform,
    nodeVersion: process.version,
  };
}

/**
 * Build the pre-filled GitHub issue: title, markdown body (with an Environment block + any
 * hint/investigation context), label list, and the encoded new-issue URL. Pure — shared by the
 * CLI command and the `report_issue` MCP tool so both produce byte-identical output.
 */
export function buildIssue(opts: {
  title?: string;
  body?: string;
  labels?: string;
  hint?: string;
}): BuiltIssue {
  const environment = issueEnvironment();
  const title = (opts.title?.trim() || (opts.hint?.trim() ? `Bug/gap: ${opts.hint.trim()}` : 'Horus bug / capability gap')).slice(0, 256);
  const labels = (opts.labels ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  const sections: string[] = [];
  sections.push('### What happened / what is missing');
  sections.push(opts.body?.trim() || '<!-- Describe the bug or the capability gap you hit. -->');
  if (opts.hint?.trim()) {
    sections.push('### Context');
    sections.push(opts.hint.trim());
  }
  sections.push('### Environment');
  sections.push(
    [
      `- Horus version: ${environment.horusVersion}`,
      `- Source intelligence: ${environment.sourceVersion}`,
      `- OS: ${environment.platform}`,
      `- Node: ${environment.nodeVersion}`,
    ].join('\n'),
  );
  const body = sections.join('\n\n');

  const url = new URL(ISSUE_BASE);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  if (labels.length > 0) url.searchParams.set('labels', labels.join(','));

  return { url: url.toString(), title, body, labels, environment };
}

export async function runReportIssue(opts: {
  title?: string;
  body?: string;
  labels?: string;
  hint?: string;
  config?: string;
}): Promise<number> {
  const issue = buildIssue(opts);

  openBrowser(issue.url);

  console.log('');
  console.log(`  ${pc.bold('File a Horus issue')} — pre-filled on ${pc.cyan('meritt-dev/horus')}:`);
  console.log('');
  console.log(`    ${pc.cyan(issue.url)}`);
  console.log('');
  console.log(pc.dim('  Your browser should open it; if not, open the URL above. (No data is sent automatically.)'));
  return 0;
}
