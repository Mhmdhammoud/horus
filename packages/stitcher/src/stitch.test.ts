/**
 * Unit tests for project-scoped stitch() (HOR-38).
 *
 * Mocks both the SourceHttpClient and the DB so no network or database is needed.
 * Verifies that edges carry the project label and that replaceQueueEdges is
 * called with the matching project scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as db from '@horus/db';
import { stitch } from './stitch.js';
import type { SourceHttpClient } from '@horus/connectors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSourceClient(producerContent: string, workerContent: string): SourceHttpClient {
  return {
    cypher: vi.fn(async (query: string) => {
      if (query.includes('@InjectQueue(') || query.includes('new Queue(')) {
        return {
          rows: [['NotificationService', 'src/notification.service.ts', producerContent]],
        };
      }
      return {
        rows: [['EmailProcessor', 'src/email.processor.ts', workerContent]],
      };
    }),
  } as unknown as SourceHttpClient;
}

const PRODUCER_CONTENT = "constructor(@InjectQueue('emails') private q: Queue) {}";
const WORKER_CONTENT = "@Processor('emails')\nexport class EmailProcessor {}";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stitch — project scoping (HOR-38)', () => {
  let replaceSpy: MockInstance;
  const fakeDb = {} as db.HorusDb;

  beforeEach(() => {
    replaceSpy = vi
      .spyOn(db, 'replaceQueueEdges')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes the project to replaceQueueEdges', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'leadcall-api' });
    expect(replaceSpy).toHaveBeenCalledOnce();
    const [, , opts] = replaceSpy.mock.calls[0] as [unknown, unknown, { project?: string }];
    expect(opts?.project).toBe('leadcall-api');
  });

  it('sets project on every inserted edge', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'maison-safqa' });
    const [, edges] = replaceSpy.mock.calls[0] as [unknown, Array<{ project: string | null }>];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.project).toBe('maison-safqa');
    }
  });

  it('uses null project when no project is given (back-compat)', async () => {
    const client = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb);
    const [, edges, opts] = replaceSpy.mock.calls[0] as [
      unknown,
      Array<{ project: string | null }>,
      { project?: string },
    ];
    expect(opts?.project).toBeUndefined();
    for (const edge of edges) {
      expect(edge.project).toBeNull();
    }
  });

  it('widened CONTAINS pre-filter fetches and stitches a procrastinate .defer() edge (HOR-380)', () => {
    // The pre-filter must request the new producer verbs / @actor in lockstep with extract.ts,
    // or the candidate nodes are never fetched and the regex never fires.
    const seen: string[] = [];
    const client = {
      cypher: vi.fn(async (query: string) => {
        seen.push(query);
        if (query.includes('@InjectQueue(') || query.includes('new Queue(')) return { rows: [] };
        if (query.includes('@Processor(') || query.includes('new Worker')) return { rows: [] };
        // The Python task-queue query: return a procrastinate worker + producer.
        return {
          rows: [
            ['sum_task', 'app/tasks.py', '@app.task\ndef sum_task(a, b):\n    return a + b'],
            ['handler', 'app/views.py', 'def handler():\n    sum_task.defer(a=1, b=2)'],
          ],
        };
      }),
    } as unknown as SourceHttpClient;

    return stitch(client, fakeDb, { project: 'queue-demo' }).then(() => {
      const celeryQuery = seen.find((q) => q.includes('.delay('));
      expect(celeryQuery).toBeDefined();
      for (const needle of ['.defer(', '.defer_async(', '.send(', '.enqueue_job(', '.enqueue(', '@actor']) {
        expect(celeryQuery).toContain(needle);
      }
      const [, edges] = replaceSpy.mock.calls[0] as [
        unknown,
        Array<{ queueName: string; producerSymbol: string | null; workerSymbol: string | null }>,
      ];
      expect(
        edges.some(
          (e) => e.queueName === 'sum_task' && e.producerSymbol === 'handler' && e.workerSymbol === 'sum_task',
        ),
      ).toBe(true);
    });
  });

  it('indexing A then B calls replaceQueueEdges twice with distinct projects', async () => {
    const clientA = makeSourceClient(PRODUCER_CONTENT, WORKER_CONTENT);
    const clientB = makeSourceClient(
      "constructor(@InjectQueue('reports') private q: Queue) {}",
      "@Processor('reports')\nexport class ReportProcessor {}",
    );
    await stitch(clientA, fakeDb, { project: 'leadcall-api' });
    await stitch(clientB, fakeDb, { project: 'maison-safqa' });

    expect(replaceSpy).toHaveBeenCalledTimes(2);
    const [, , optsA] = replaceSpy.mock.calls[0] as [unknown, unknown, { project?: string }];
    const [, , optsB] = replaceSpy.mock.calls[1] as [unknown, unknown, { project?: string }];
    expect(optsA?.project).toBe('leadcall-api');
    expect(optsB?.project).toBe('maison-safqa');
  });
});
