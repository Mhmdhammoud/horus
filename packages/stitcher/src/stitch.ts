/**
 * The stitcher orchestration: pull producer Class nodes and worker File nodes from source
 * intelligence over the typed content-search endpoint (HOR-392), run the pure extractor, and
 * replace the stitcher-owned rows in `queue_edges`. This is the one source-intelligence layer
 * the static graph can't give.
 */
import { SourceHttpClient } from '@horus/connectors';
import { replaceQueueEdges, type HorusDb, type NewQueueEdge } from '@horus/db';
import {
  extractQueueGraph,
  extractCeleryQueueGraph,
  extractDramatiqQueueGraph,
  type ProducerClassInput,
  type WorkerFileInput,
  type CeleryNodeInput,
} from './extract.js';

export interface StitchSummary {
  queues: number;
  producers: number;
  workers: number;
  edges: number;
}

export async function stitch(
  client: SourceHttpClient,
  db: HorusDb,
  opts: { project?: string } = {},
): Promise<StitchSummary> {
  // Producers: NestJS @InjectQueue (Class), raw `new Queue(...)`, and modules that
  // declare a queue-name constant (the queue's definition site). `MATCH (n)` (any
  // label) because raw bullmq lives in Files/Functions, not just Classes.
  //
  // Also pulls the indirection sources the extractor needs to resolve dynamically
  // registered queues (HOR-341): enum declarations (`new Queue(Enum.MEMBER)` /
  // `Object.values(Enum)` resolution) and dispatch tables that map enum members to
  // handler functions. These are harmless extra rows for the literal-string path.
  const producerRows = await client.contentSearch([
    // "new Queue" (no paren) so generic-typed `new Queue<T>(...)` also matches.
    '@InjectQueue(',
    'new Queue',
    'QUEUE_NAME',
    'QueueName',
    'enum ',
    'Object.values(',
    // HOR-341: dispatch tables `[Enum.MEMBER]: () => this.ctrl.handler()` map runtime
    // queues to owning code, and often live in a file with NO new Queue/Worker of their
    // own (e.g. a scheduler controller) — so pull computed-key arrow entries too.
    ']: (',
  ]);
  const producerClasses: ProducerClassInput[] = producerRows.map((r) => ({
    name: r.name,
    filePath: r.filePath,
    content: r.content,
  }));

  // Workers: NestJS class-level @Processor, and raw `new Worker(...)`.
  // "new Worker" (no paren) so generic-typed `new Worker<T>(...)` also matches.
  const workerRows = await client.contentSearch(['@Processor(', 'new Worker']);
  const workerFiles: WorkerFileInput[] = workerRows.map((r) => ({
    filePath: r.filePath,
    content: r.content,
  }));

  const graph = extractQueueGraph({ producerClasses, workerFiles });

  // Python task-queue boundaries — Celery (HOR-356) + huey/procrastinate/dramatiq (HOR-380): a
  // `@task`/`@actor def foo` is the worker for task "foo"; a `foo.delay()`/`foo.apply_async()`
  // (Celery), `foo.schedule()` (huey), `foo.defer()`/`foo.defer_async()` (procrastinate), or
  // `foo.send()` (dramatiq) call site is the producer. The static flow graph can't connect them —
  // the same gap BullMQ has — so stitch them here. This CONTAINS pre-filter MUST stay in lockstep
  // with extract.ts's CELERY_ENQUEUE_RE/CELERY_TASK_DEF_RE: candidate nodes that aren't fetched
  // here are invisible to the regex. arq's `.enqueue_job(` / rq's `.enqueue(` are fetched too, but
  // they have no worker-side decorator so their producers drop under the taskQueues filter.
  const celeryRows = await client.contentSearch([
    '.delay(',
    '.apply_async(',
    '.schedule(',
    '.defer(',
    '.defer_async(',
    '.send(',
    '.enqueue_job(',
    '.enqueue(',
    '@shared_task',
    '@task',
    '.task',
    '@actor',
    'periodic_task',
    'db_task',
  ]);
  const celeryNodes: CeleryNodeInput[] = celeryRows.map((r) => ({
    name: r.name,
    filePath: r.filePath,
    content: r.content,
  }));
  const celery = extractCeleryQueueGraph(celeryNodes);
  // dramatiq is fetched by the same CONTAINS pre-filter (`.send(` + `@actor`) but modeled
  // separately: its queue is the broker queue (default "default"), not the actor name (HOR-411).
  const dramatiq = extractDramatiqQueueGraph(celeryNodes);

  const edges: NewQueueEdge[] = [...graph.edges, ...celery.edges, ...dramatiq.edges].map((e) => ({
    queueName: e.queueName,
    producerSymbol: e.producerSymbol,
    producerFile: e.producerFile,
    workerSymbol: e.workerSymbol,
    workerFile: e.workerFile,
    source: 'stitcher',
    project: opts.project ?? null,
  }));

  await replaceQueueEdges(db, edges, { project: opts.project });

  return {
    queues: graph.queues.length + celery.queues.length + dramatiq.queues.length,
    producers: graph.producers.length + celery.producers.length + dramatiq.producers.length,
    workers: graph.workers.length + celery.workers.length + dramatiq.workers.length,
    edges: edges.length,
  };
}
