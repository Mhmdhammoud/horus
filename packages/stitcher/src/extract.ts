/**
 * Pure queue-graph extraction — no IO. Parses BullMQ/NestJS queue-name literals out of
 * Axon symbol "content" and joins producers to workers on the queue-name string.
 *
 * Producers are discovered from `@InjectQueue('<name>')` inside a Class node's content.
 * Workers are discovered from a class-level `@Processor('<name>')` decorator, which lives
 * in the FILE node's content (a class-level decorator is NOT in the Class node content).
 */

export interface ProducerClassInput {
  name: string;
  filePath: string;
  content: string;
}

export interface WorkerFileInput {
  filePath: string;
  content: string;
}

export interface SynthEdge {
  queueName: string;
  producerSymbol: string | null;
  producerFile: string | null;
  workerSymbol: string | null;
  workerFile: string | null;
}

export interface QueueGraph {
  queues: string[];
  producers: { queue: string; symbol: string; file: string }[];
  workers: { queue: string; symbol: string; file: string }[];
  edges: SynthEdge[];
}

/** Matches `@InjectQueue('<name>')` — captures the queue name in group 1. */
const INJECT_QUEUE_RE = /@InjectQueue\(\s*['"]([^'"]+)['"]/g;

/**
 * Matches a class-level `@Processor('<name>', {...})` decorator followed (possibly through
 * additional decorators) by `export class <ClassName>`. Group 1 = queue, group 2 = class.
 */
const PROCESSOR_RE =
  /@Processor\(\s*['"]([^'"]+)['"][^)]*\)\s*(?:@\w+[^\n]*\s*)*export\s+class\s+(\w+)/g;

export function extractQueueGraph(input: {
  producerClasses: ProducerClassInput[];
  workerFiles: WorkerFileInput[];
}): QueueGraph {
  const producers: { queue: string; symbol: string; file: string }[] = [];
  for (const pc of input.producerClasses) {
    for (const m of pc.content.matchAll(INJECT_QUEUE_RE)) {
      const queue = m[1] ?? '';
      if (!queue) continue;
      producers.push({ queue, symbol: pc.name, file: pc.filePath });
    }
  }

  const workers: { queue: string; symbol: string; file: string }[] = [];
  for (const wf of input.workerFiles) {
    for (const m of wf.content.matchAll(PROCESSOR_RE)) {
      const queue = m[1] ?? '';
      const className = m[2] ?? '';
      if (!queue) continue;
      workers.push({ queue, symbol: className, file: wf.filePath });
    }
  }

  const queues = [...new Set([...producers, ...workers].map((r) => r.queue))].sort();

  const edges: SynthEdge[] = [];
  for (const q of queues) {
    const P = producers.filter((p) => p.queue === q);
    const W = workers.filter((w) => w.queue === q);
    if (P.length && W.length) {
      for (const p of P) {
        for (const w of W) {
          edges.push({
            queueName: q,
            producerSymbol: p.symbol,
            producerFile: p.file,
            workerSymbol: w.symbol,
            workerFile: w.file,
          });
        }
      }
    } else if (W.length) {
      for (const w of W) {
        edges.push({
          queueName: q,
          producerSymbol: null,
          producerFile: null,
          workerSymbol: w.symbol,
          workerFile: w.file,
        });
      }
    } else if (P.length) {
      for (const p of P) {
        edges.push({
          queueName: q,
          producerSymbol: p.symbol,
          producerFile: p.file,
          workerSymbol: null,
          workerFile: null,
        });
      }
    }
  }

  return { queues, producers, workers, edges };
}
