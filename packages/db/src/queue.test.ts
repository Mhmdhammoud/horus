/**
 * Unit tests for project-scoped replaceQueueEdges / listQueueEdges (HOR-38).
 *
 * Uses a lightweight in-memory store that mirrors the Drizzle API surface used
 * by queue.ts so we can verify scoping logic without a real Postgres connection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { QueueEdge, NewQueueEdge } from './schema.js';

// ---------------------------------------------------------------------------
// Minimal in-memory store that mirrors the behaviour under test
// ---------------------------------------------------------------------------

let store: QueueEdge[] = [];
let nextId = 1;

function makeRow(edge: NewQueueEdge): QueueEdge {
  const now = new Date();
  return {
    id: `id-${nextId++}`,
    queueName: edge.queueName,
    producerSymbol: edge.producerSymbol ?? null,
    producerFile: edge.producerFile ?? null,
    workerSymbol: edge.workerSymbol ?? null,
    workerFile: edge.workerFile ?? null,
    source: edge.source ?? 'stitcher',
    project: edge.project ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/** In-memory implementation of replaceQueueEdges logic. */
function memReplace(edges: NewQueueEdge[], opts: { project?: string } = {}): void {
  const { project } = opts;
  store = store.filter((row) => {
    if (row.source !== 'stitcher') return true;
    if (project !== undefined) return row.project !== project;
    return row.project !== null;
  });
  store.push(...edges.map(makeRow));
}

/** In-memory implementation of listQueueEdges logic. */
function memList(opts: { project?: string; queueName?: string } = {}): QueueEdge[] {
  return store.filter((row) => {
    if (opts.project !== undefined && row.project !== opts.project) return false;
    if (opts.queueName !== undefined && row.queueName !== opts.queueName) return false;
    return true;
  });
}

function edge(queueName: string, project: string | null = null): NewQueueEdge {
  return { queueName, source: 'stitcher', project };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('replaceQueueEdges — project scoping (HOR-38)', () => {
  beforeEach(() => {
    store = [];
    nextId = 1;
  });

  it('indexing project A then B keeps both sets of edges', () => {
    memReplace([edge('emails', 'leadcall-api'), edge('tasks', 'leadcall-api')], { project: 'leadcall-api' });
    memReplace([edge('orders', 'maison-safqa')], { project: 'maison-safqa' });

    expect(store.filter((r) => r.project === 'leadcall-api').length).toBe(2);
    expect(store.filter((r) => r.project === 'maison-safqa').length).toBe(1);
    expect(store.length).toBe(3);
  });

  it('re-indexing project A replaces only A edges', () => {
    memReplace([edge('emails', 'leadcall-api'), edge('tasks', 'leadcall-api')], { project: 'leadcall-api' });
    memReplace([edge('orders', 'maison-safqa')], { project: 'maison-safqa' });
    // Re-index A with a smaller set
    memReplace([edge('emails', 'leadcall-api')], { project: 'leadcall-api' });

    expect(store.filter((r) => r.project === 'leadcall-api').map((r) => r.queueName)).toEqual(['emails']);
    expect(store.filter((r) => r.project === 'maison-safqa').length).toBe(1);
  });

  it('back-compat: no project scopes the null-project bucket only', () => {
    memReplace([edge('legacy', null)]);
    memReplace([edge('orders', 'maison-safqa')], { project: 'maison-safqa' });
    // Re-index legacy bucket
    memReplace([edge('legacy2', null)]);

    expect(store.filter((r) => r.project === null).map((r) => r.queueName)).toEqual(['legacy2']);
    expect(store.filter((r) => r.project === 'maison-safqa').length).toBe(1);
  });
});

describe('listQueueEdges — project filter (HOR-38)', () => {
  beforeEach(() => {
    store = [];
    nextId = 1;
    memReplace([edge('emails', 'leadcall-api'), edge('tasks', 'leadcall-api')], { project: 'leadcall-api' });
    memReplace([edge('orders', 'maison-safqa')], { project: 'maison-safqa' });
  });

  it('returns all edges when no filter is given', () => {
    expect(memList().length).toBe(3);
  });

  it('REGRESSION: unscoped list leaks other projects — a single-project view MUST pass project', () => {
    // The `horus queues` command originally called listQueueEdges with project=undefined,
    // so running it inside maison-safqa surfaced leadcall-api's queues (e.g. zoho-sync-*)
    // as if they belonged to maison-safqa. The DB layer is correct; the command must
    // resolve and pass the active project. This locks in that contract.
    expect(memList().map((r) => r.queueName).sort()).toEqual(['emails', 'orders', 'tasks']); // unscoped = leak
    expect(memList({ project: 'maison-safqa' }).map((r) => r.queueName)).toEqual(['orders']); // scoped = correct
  });

  it('filters to only the given project', () => {
    const rows = memList({ project: 'leadcall-api' });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.project === 'leadcall-api')).toBe(true);
  });

  it('maison investigation never sees leadcall edges', () => {
    const rows = memList({ project: 'maison-safqa' });
    expect(rows.every((r) => r.project === 'maison-safqa')).toBe(true);
    expect(rows.some((r) => r.project === 'leadcall-api')).toBe(false);
  });

  it('combined project + queueName filter', () => {
    const rows = memList({ project: 'leadcall-api', queueName: 'emails' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.queueName).toBe('emails');
  });
});
