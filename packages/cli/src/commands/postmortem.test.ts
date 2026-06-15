/**
 * HOR-111 — Unit tests for `horus postmortem` file-export path.
 *
 * Tests are DB-free: they inject a pre-built report via opts._report to bypass
 * Postgres. The DB-dependent path (getInvestigation) is covered by integration
 * tests elsewhere.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { InvestigationReport } from '@horus/engine';
import { runPostmortem } from './postmortem.js';

// ---------------------------------------------------------------------------
// Minimal fixture — enough for generatePostmortem to produce real output
// ---------------------------------------------------------------------------

const FIXTURE: InvestigationReport = {
  id: 'test-postmortem-001',
  input: { hint: 'checkout-api timeouts after deploy', service: 'checkout-api', since: '2026-06-15' },
  summary: 'A gateway timeout increase correlates with the incident window.',
  seeds: [],
  evidence: [
    {
      id: 'ev-commit-aabb1122',
      source: 'history',
      kind: 'commit',
      title: 'Increase gateway timeout from 3 s to 30 s',
      relevance: 0.9,
      payload: {},
      links: {},
      provenance: { query: 'git log', collectedAt: '2026-06-15T10:00:00Z' },
    },
  ],
  timeline: { events: [], boundaryCrossings: [] },
  correlation: { groups: [], chains: [], missing: [] },
  findings: [
    { kind: 'correlation', title: 'Timeout change correlates with slowdown', confidence: 0.75, evidenceIds: ['ev-commit-aabb1122'] },
  ],
  suspectedCauses: [
    {
      id: 'cause-001',
      title: 'Timeout increase caused cascading delays',
      category: 'configuration',
      sourceEvidenceIds: ['ev-commit-aabb1122'],
      affectedNodeIds: [],
      baseScore: 0.7,
      finalScore: 0.75,
      confidence: 0.75,
      band: 'likely',
      explanations: [],
    },
  ],
  hypotheses: [],
  similarIncidents: [],
  gapAnalysis: {
    gaps: [
      {
        dimension: 'logs',
        why: 'No Elasticsearch connector configured.',
        nextSource: 'Add an `elasticsearch` connector',
        confidenceImpact: 0.1,
      },
    ],
    blindSpots: ['Cannot confirm error signatures.'],
    confidenceCeiling: 0.9,
  },
  graph: { nodes: [], edges: [] },
  confidence: 0.7,
  nextActions: ['Review gateway timeout change', 'Add an `elasticsearch` connector'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'horus-postmortem-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function capture(
  fn: (write: (line: string) => void) => Promise<number>,
): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  return fn((line) => lines.push(line)).then((code) => ({ lines, code }));
}

// ---------------------------------------------------------------------------
// 1. stdout path (no --output)
// ---------------------------------------------------------------------------

describe('runPostmortem — stdout path', () => {
  it('exits 0 and emits a postmortem', async () => {
    const { code, lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, write }),
    );
    expect(code).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('output includes the incident hint in the title', async () => {
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, write }),
    );
    const full = lines.join('\n');
    expect(full).toContain('checkout-api timeouts after deploy');
  });

  it('output includes ## Summary section', async () => {
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, write }),
    );
    expect(lines.join('\n')).toContain('## Summary');
  });

  it('output includes ## Follow-up actions section', async () => {
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, write }),
    );
    expect(lines.join('\n')).toContain('## Follow-up actions');
  });

  it('output includes commit evidence title', async () => {
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, write }),
    );
    expect(lines.join('\n')).toContain('Increase gateway timeout from 3 s to 30 s');
  });
});

// ---------------------------------------------------------------------------
// 2. file output path (--output)
// ---------------------------------------------------------------------------

describe('runPostmortem — file output path', () => {
  it('exits 0 and creates the output file', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    const code = await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      write: () => {},
    });
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it('file contains valid Markdown with the incident hint', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      write: () => {},
    });
    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('checkout-api timeouts after deploy');
    expect(content).toContain('## Summary');
    expect(content).toContain('## Follow-up actions');
  });

  it('file contains evidence section with commit evidence title', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      write: () => {},
    });
    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('Increase gateway timeout from 3 s to 30 s');
  });

  it('prints a "Saved" confirmation line when --output is used', async () => {
    const dir = tempDir();
    const { lines, code } = await capture((write) =>
      runPostmortem('ignored-id', {
        _report: FIXTURE,
        output: join(dir, 'out.md'),
        write,
      }),
    );
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Saved postmortem to');
  });

  it('nothing is printed to stdout (no postmortem body) when --output is used', async () => {
    const dir = tempDir();
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', {
        _report: FIXTURE,
        output: join(dir, 'out.md'),
        write,
      }),
    );
    const full = lines.join('\n');
    expect(full).not.toContain('## Summary');
  });
});

// ---------------------------------------------------------------------------
// 3. overwrite protection
// ---------------------------------------------------------------------------

describe('runPostmortem — overwrite protection', () => {
  it('exits 1 when output file exists and --force is not set', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    writeFileSync(outPath, 'existing content', 'utf8');
    const code = await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      write: () => {},
    });
    expect(code).toBe(1);
  });

  it('preserves existing content on refusal', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    writeFileSync(outPath, 'existing content', 'utf8');
    await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      write: () => {},
    });
    expect(readFileSync(outPath, 'utf8')).toBe('existing content');
  });

  it('mentions --force in the refusal message', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    writeFileSync(outPath, 'existing', 'utf8');
    const { lines } = await capture((write) =>
      runPostmortem('ignored-id', { _report: FIXTURE, output: outPath, write }),
    );
    expect(lines.join('\n')).toContain('--force');
  });

  it('exits 0 and overwrites when --force is passed', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'postmortem.md');
    writeFileSync(outPath, 'old content', 'utf8');
    const code = await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      force: true,
      write: () => {},
    });
    expect(code).toBe(0);
    const content = readFileSync(outPath, 'utf8');
    expect(content).not.toBe('old content');
    expect(content).toContain('## Summary');
  });

  it('--force on a non-existent file still exits 0', async () => {
    const dir = tempDir();
    const outPath = join(dir, 'new.md');
    const code = await runPostmortem('ignored-id', {
      _report: FIXTURE,
      output: outPath,
      force: true,
      write: () => {},
    });
    expect(code).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });
});
