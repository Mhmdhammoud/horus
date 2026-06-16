/**
 * HOR-184 — Regression tests for reconstructChangeTimeline and renderChangeTimeline.
 * Pure unit tests — connectors are stubbed, no git I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeProvider, GitCommit } from '@horus/connectors';
import type { Symbol, Flow } from '@horus/core';

vi.mock('@horus/connectors', () => ({
  gitLog: vi.fn(),
}));

import * as connectors from '@horus/connectors';
import { reconstructChangeTimeline } from './deploy-timeline.js';
import { renderChangeTimeline } from './render-timeline.js';

const mockGitLog = vi.mocked(connectors.gitLog);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCommit(sha: string, subject: string, files: string[] = ['src/index.ts']): GitCommit {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    subject,
    author: 'Dev',
    dateIso: '2026-01-01',
    files,
  };
}

function makeSymbol(name: string): Symbol {
  return {
    id: 'function:' + name,
    name,
    filePath: 'src/' + name + '.ts',
    startLine: 1,
    endLine: 10,
    language: 'typescript',
  };
}

function makeFlow(id: string, name: string): Flow {
  return { id, name, steps: [] };
}

function makeCode(
  changeResult: Awaited<ReturnType<CodeProvider['detectChanges']>>,
  flowsMap: Record<string, Flow[]> = {},
): CodeProvider {
  return {
    health: vi.fn(),
    searchSymbols: vi.fn(),
    context: vi.fn(),
    impact: vi.fn(),
    flowsFor: vi.fn(async (symbolId: string) => flowsMap[symbolId] ?? []),
    detectChanges: vi.fn(async () => changeResult),
  } as unknown as CodeProvider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconstructChangeTimeline', () => {
  it('summary ends with exactly one period — no double period from embedding impact.summary', async () => {
    const commits = [makeCommit('sha22222', 'feat: payment'), makeCommit('sha11111', 'init')];
    const sym = makeSymbol('PaymentService');
    const flow = makeFlow('flow:checkout', 'Checkout flow');

    mockGitLog.mockResolvedValueOnce(commits);
    const code = makeCode(
      { added: [sym], modified: [], removed: [] },
      { 'function:PaymentService': [flow] },
    );

    const timeline = await reconstructChangeTimeline(
      { repoPath: '/repo', since: '7 days ago' },
      { code },
    );

    expect(timeline.summary.endsWith('.')).toBe(true);
    expect(timeline.summary.endsWith('..')).toBe(false);
  });

  it('changeImpact reflects the correct flow when a changed symbol belongs to a flow', async () => {
    const commits = [makeCommit('sha22222', 'feat: order'), makeCommit('sha11111', 'init')];
    const sym = makeSymbol('OrderProcessor');
    const flow = makeFlow('flow:order', 'Order processing flow');

    mockGitLog.mockResolvedValueOnce(commits);
    const code = makeCode(
      { added: [sym], modified: [], removed: [] },
      { 'function:OrderProcessor': [flow] },
    );

    const timeline = await reconstructChangeTimeline(
      { repoPath: '/repo', since: '7 days ago' },
      { code },
    );

    expect(timeline.changeImpact).not.toBeNull();
    expect(timeline.changeImpact!.affectedFlows).toHaveLength(1);
    expect(timeline.changeImpact!.affectedFlows[0]?.flowId).toBe('flow:order');
  });

  it('returns null changeImpact when there are no commits', async () => {
    mockGitLog.mockResolvedValueOnce([]);
    const code = makeCode({ added: [], modified: [], removed: [] });

    const timeline = await reconstructChangeTimeline({ repoPath: '/repo' }, { code });

    expect(timeline.changeImpact).toBeNull();
    expect(timeline.commits).toHaveLength(0);
  });

  it('window reflects the input since/until values', async () => {
    mockGitLog.mockResolvedValueOnce([]);
    const code = makeCode({ added: [], modified: [], removed: [] });

    const timeline = await reconstructChangeTimeline(
      { repoPath: '/repo', since: '7 days ago', until: 'HEAD' },
      { code },
    );

    expect(timeline.window.since).toBe('7 days ago');
    expect(timeline.window.until).toBe('HEAD');
  });
});

describe('renderChangeTimeline', () => {
  it('shows "Range:" line with since label', async () => {
    mockGitLog.mockResolvedValueOnce([makeCommit('aabbcc1', 'feat: order')]);
    const code = makeCode({ added: [], modified: [], removed: [] });

    const timeline = await reconstructChangeTimeline(
      { repoPath: '/repo', since: '7 days ago' },
      { code },
    );
    const output = renderChangeTimeline(timeline);

    expect(output).toContain('Range:');
    expect(output).toContain('7 days ago');
  });

  it('shows "(all history)" when no since is provided', async () => {
    mockGitLog.mockResolvedValueOnce([]);
    const code = makeCode({ added: [], modified: [], removed: [] });

    const timeline = await reconstructChangeTimeline({ repoPath: '/repo' }, { code });
    const output = renderChangeTimeline(timeline);

    expect(output).toContain('(all history)');
  });

  it('shows git range in change impact section and lists affected flow names', async () => {
    const commits = [makeCommit('sha22222', 'feat'), makeCommit('sha11111', 'init')];
    const sym = makeSymbol('SomeService');
    const flow = makeFlow('flow:main', 'Main checkout flow');

    mockGitLog.mockResolvedValueOnce(commits);
    const code = makeCode(
      { added: [sym], modified: [], removed: [] },
      { 'function:SomeService': [flow] },
    );

    const timeline = await reconstructChangeTimeline({ repoPath: '/repo' }, { code });
    const output = renderChangeTimeline(timeline);

    expect(output).toContain('Git range:');
    expect(output).toContain('Main checkout flow');
  });

  it('does not repeat the affected-flows count as "Affected flows: N."', async () => {
    const commits = [makeCommit('sha22222', 'feat'), makeCommit('sha11111', 'init')];
    const sym = makeSymbol('SomeService');
    const flow = makeFlow('flow:main', 'Main flow');

    mockGitLog.mockResolvedValueOnce(commits);
    const code = makeCode(
      { added: [sym], modified: [], removed: [] },
      { 'function:SomeService': [flow] },
    );

    const timeline = await reconstructChangeTimeline({ repoPath: '/repo' }, { code });
    const output = renderChangeTimeline(timeline);

    // Must NOT have the old "Affected flows: N." pattern after the summary line
    expect(output).not.toMatch(/execution flow\(s\) affected\.\s+Affected flows:/);
  });
});
