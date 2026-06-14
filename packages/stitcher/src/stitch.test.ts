/**
 * Unit tests for project-scoped stitch() (HOR-38).
 *
 * Mocks both the AxonHttpClient and the DB so no network or database is needed.
 * Verifies that edges carry the project label and that replaceQueueEdges is
 * called with the matching project scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as db from '@horus/db';
import { stitch } from './stitch.js';
import type { AxonHttpClient } from '@horus/connectors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAxon(producerContent: string, workerContent: string): AxonHttpClient {
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
  } as unknown as AxonHttpClient;
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
    const client = makeAxon(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'leadcall-api' });
    expect(replaceSpy).toHaveBeenCalledOnce();
    const [, , opts] = replaceSpy.mock.calls[0] as [unknown, unknown, { project?: string }];
    expect(opts?.project).toBe('leadcall-api');
  });

  it('sets project on every inserted edge', async () => {
    const client = makeAxon(PRODUCER_CONTENT, WORKER_CONTENT);
    await stitch(client, fakeDb, { project: 'maison-safqa' });
    const [, edges] = replaceSpy.mock.calls[0] as [unknown, Array<{ project: string | null }>];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.project).toBe('maison-safqa');
    }
  });

  it('uses null project when no project is given (back-compat)', async () => {
    const client = makeAxon(PRODUCER_CONTENT, WORKER_CONTENT);
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

  it('indexing A then B calls replaceQueueEdges twice with distinct projects', async () => {
    const clientA = makeAxon(PRODUCER_CONTENT, WORKER_CONTENT);
    const clientB = makeAxon(
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
