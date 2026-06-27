/**
 * The stitcher orchestration: pull producer Class nodes and worker File nodes from source intelligence
 * over read-only Cypher, run the pure extractor, and replace the stitcher-owned rows in
 * `queue_edges`. This is the one source-intelligence layer the static graph can't give.
 */
import { SourceHttpClient } from '@horus/connectors';
import { replaceQueueEdges, type HorusDb, type NewQueueEdge } from '@horus/db';
import {
  extractQueueGraph,
  extractCeleryQueueGraph,
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
  const producerRows = (
    await client.cypher(
      // "new Queue" (no paren) so generic-typed `new Queue<T>(...)` also matches.
      'MATCH (n) WHERE n.content CONTAINS "@InjectQueue(" OR n.content CONTAINS "new Queue" ' +
        'OR n.content CONTAINS "QUEUE_NAME" OR n.content CONTAINS "QueueName" ' +
        'OR n.content CONTAINS "enum " OR n.content CONTAINS "Object.values(" ' +
        // HOR-341: dispatch tables `[Enum.MEMBER]: () => this.ctrl.handler()` map runtime
        // queues to owning code, and often live in a file with NO new Queue/Worker of their
        // own (e.g. a scheduler controller) — so pull computed-key arrow entries too.
        'OR n.content CONTAINS "]: (" ' +
        'RETURN n.name, n.file_path, n.content',
    )
  ).rows;
  const producerClasses: ProducerClassInput[] = producerRows.map((r) => ({
    name: String(r[0] ?? ''),
    filePath: String(r[1] ?? ''),
    content: String(r[2] ?? ''),
  }));

  // Workers: NestJS class-level @Processor, and raw `new Worker(...)`.
  const workerRows = (
    await client.cypher(
      // "new Worker" (no paren) so generic-typed `new Worker<T>(...)` also matches.
      'MATCH (n) WHERE n.content CONTAINS "@Processor(" OR n.content CONTAINS "new Worker" ' +
        'RETURN n.name, n.file_path, n.content',
    )
  ).rows;
  const workerFiles: WorkerFileInput[] = workerRows.map((r) => ({
    filePath: String(r[1] ?? ''),
    content: String(r[2] ?? ''),
  }));

  const graph = extractQueueGraph({ producerClasses, workerFiles });

  // Celery (Python) queue boundaries (HOR-356): a `@task def foo` is the worker for task
  // "foo"; a `foo.delay()` / `foo.apply_async()` call site is the producer. The static flow
  // graph can't connect them — the same gap BullMQ has — so stitch them here too.
  const celeryRows = (
    await client.cypher(
      'MATCH (n) WHERE n.content CONTAINS ".delay(" OR n.content CONTAINS ".apply_async(" ' +
        'OR n.content CONTAINS "@shared_task" OR n.content CONTAINS "@task" OR n.content CONTAINS ".task" ' +
        'RETURN n.name, n.file_path, n.content',
    )
  ).rows;
  const celeryNodes: CeleryNodeInput[] = celeryRows.map((r) => ({
    name: String(r[0] ?? ''),
    filePath: String(r[1] ?? ''),
    content: String(r[2] ?? ''),
  }));
  const celery = extractCeleryQueueGraph(celeryNodes);

  const edges: NewQueueEdge[] = [...graph.edges, ...celery.edges].map((e) => ({
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
    queues: graph.queues.length + celery.queues.length,
    producers: graph.producers.length + celery.producers.length,
    workers: graph.workers.length + celery.workers.length,
    edges: edges.length,
  };
}
