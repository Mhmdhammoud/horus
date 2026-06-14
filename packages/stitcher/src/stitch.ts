/**
 * The stitcher orchestration: pull producer Class nodes and worker File nodes from Axon
 * over read-only Cypher, run the pure extractor, and replace the stitcher-owned rows in
 * `queue_edges`. This is the one source-intelligence layer Axon's static graph can't give.
 */
import { AxonHttpClient } from '@horus/connectors';
import { replaceQueueEdges, type HorusDb, type NewQueueEdge } from '@horus/db';
import {
  extractQueueGraph,
  type ProducerClassInput,
  type WorkerFileInput,
} from './extract.js';

export interface StitchSummary {
  queues: number;
  producers: number;
  workers: number;
  edges: number;
}

export async function stitch(
  client: AxonHttpClient,
  db: HorusDb,
): Promise<StitchSummary> {
  const producerRows = (
    await client.cypher(
      'MATCH (n:Class) WHERE n.content CONTAINS "@InjectQueue(" RETURN n.name, n.file_path, n.content',
    )
  ).rows;
  const producerClasses: ProducerClassInput[] = producerRows.map((r) => ({
    name: String(r[0] ?? ''),
    filePath: String(r[1] ?? ''),
    content: String(r[2] ?? ''),
  }));

  const workerRows = (
    await client.cypher(
      'MATCH (n:File) WHERE n.content CONTAINS "@Processor(" RETURN n.name, n.file_path, n.content',
    )
  ).rows;
  const workerFiles: WorkerFileInput[] = workerRows.map((r) => ({
    filePath: String(r[1] ?? ''),
    content: String(r[2] ?? ''),
  }));

  const graph = extractQueueGraph({ producerClasses, workerFiles });

  const edges: NewQueueEdge[] = graph.edges.map((e) => ({
    queueName: e.queueName,
    producerSymbol: e.producerSymbol,
    producerFile: e.producerFile,
    workerSymbol: e.workerSymbol,
    workerFile: e.workerFile,
    source: 'stitcher',
  }));

  await replaceQueueEdges(db, edges);

  return {
    queues: graph.queues.length,
    producers: graph.producers.length,
    workers: graph.workers.length,
    edges: edges.length,
  };
}
