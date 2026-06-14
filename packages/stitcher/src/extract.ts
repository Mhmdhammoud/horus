/**
 * Pure queue-graph extraction — no IO. Parses BullMQ/NestJS queue-name literals out of
 * Axon symbol "content" and joins producers to workers on the queue-name string.
 *
 * Two idioms are supported, generically (no project-specific names):
 *  - NestJS @nestjs/bull(mq): `@InjectQueue('<name>')` producers, class-level
 *    `@Processor('<name>')` workers (inline string literals).
 *  - Raw bullmq: `new Queue(<arg>)` / `new Worker(<arg>)` where `<arg>` is a string
 *    literal OR a constant (e.g. `const X_QUEUE_NAME = 'name'`) resolved across files.
 *    A module that DECLARES a queue-name constant is treated as that queue's producer
 *    (its definition site), which links it to the `new Worker(...)` consumer.
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

// --- NestJS patterns (inline string literals) ---
const INJECT_QUEUE_RE = /@InjectQueue\(\s*['"]([^'"]+)['"]/g;
const PROCESSOR_RE =
  /@Processor\(\s*['"]([^'"]+)['"][^)]*\)\s*(?:@\w+[^\n]*\s*)*export\s+class\s+(\w+)/g;

// --- Raw bullmq patterns ---
// `const IDENT = 'literal'` (also `export const`) — for cross-file constant resolution.
const CONST_DECL_RE = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g;
// `[<ident> =] new Queue|Worker [<T>] ( <arg>` where arg is a literal or an identifier.
const NEW_BULL_RE =
  /(?:(\w+)\s*[:=]\s*)?new\s+(Queue|Worker)\s*(?:<[^>]*>)?\s*\(\s*(['"][^'"]+['"]|[A-Za-z_$][\w$.]*)/g;
// A queue-name constant: identifier contains QUEUE/Queue — its module is the producer.
const QUEUE_NAME_CONST_RE =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*(?:QUEUE|Queue)[\w$]*)\s*=\s*['"]([^'"]+)['"]/g;

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  const last = parts[parts.length - 1] ?? filePath;
  return last.replace(/\.[jt]sx?$/, '');
}

/** Resolve a `new Queue/Worker` argument to a queue name via the constant map. */
function resolveArg(raw: string, constMap: Map<string, string>): string | null {
  const arg = raw.trim();
  if (arg.startsWith('"') || arg.startsWith("'")) {
    return arg.slice(1, -1);
  }
  return constMap.get(arg) ?? null;
}

export function extractQueueGraph(input: {
  producerClasses: ProducerClassInput[];
  workerFiles: WorkerFileInput[];
}): QueueGraph {
  // Global constant map (IDENT -> literal) from every unit's content.
  const constMap = new Map<string, string>();
  const allContent = [
    ...input.producerClasses.map((p) => p.content),
    ...input.workerFiles.map((w) => w.content),
  ];
  for (const content of allContent) {
    for (const m of content.matchAll(CONST_DECL_RE)) {
      const ident = m[1];
      const value = m[2];
      if (ident && value && !constMap.has(ident)) constMap.set(ident, value);
    }
  }

  const producers: { queue: string; symbol: string; file: string }[] = [];
  for (const pc of input.producerClasses) {
    // NestJS @InjectQueue('name')
    for (const m of pc.content.matchAll(INJECT_QUEUE_RE)) {
      const queue = m[1] ?? '';
      if (queue) producers.push({ queue, symbol: pc.name, file: pc.filePath });
    }
    // Raw `new Queue(<arg>)`
    for (const m of pc.content.matchAll(NEW_BULL_RE)) {
      if (m[2] !== 'Queue') continue;
      const queue = resolveArg(m[3] ?? '', constMap);
      if (queue) {
        producers.push({ queue, symbol: (m[1] ?? pc.name) || baseName(pc.filePath), file: pc.filePath });
      }
    }
    // A module declaring a queue-name constant is that queue's definition/producer site.
    for (const m of pc.content.matchAll(QUEUE_NAME_CONST_RE)) {
      const ident = m[1] ?? '';
      const queue = m[2] ?? '';
      if (queue) producers.push({ queue, symbol: ident || baseName(pc.filePath), file: pc.filePath });
    }
  }

  const workers: { queue: string; symbol: string; file: string }[] = [];
  for (const wf of input.workerFiles) {
    // NestJS class-level @Processor('name')
    for (const m of wf.content.matchAll(PROCESSOR_RE)) {
      const queue = m[1] ?? '';
      const className = m[2] ?? '';
      if (queue) workers.push({ queue, symbol: className, file: wf.filePath });
    }
    // Raw `new Worker(<arg>)`
    for (const m of wf.content.matchAll(NEW_BULL_RE)) {
      if (m[2] !== 'Worker') continue;
      const queue = resolveArg(m[3] ?? '', constMap);
      if (queue) {
        workers.push({ queue, symbol: m[1] ?? baseName(wf.filePath), file: wf.filePath });
      }
    }
  }

  const queues = [...new Set([...producers, ...workers].map((r) => r.queue))].sort();

  const edges: SynthEdge[] = [];
  for (const q of queues) {
    // Dedup producers/workers per queue by file so repeated matches don't multiply edges.
    const P = dedupeByFile(producers.filter((p) => p.queue === q));
    const W = dedupeByFile(workers.filter((w) => w.queue === q));
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

function dedupeByFile(
  rows: { queue: string; symbol: string; file: string }[],
): { queue: string; symbol: string; file: string }[] {
  const seen = new Set<string>();
  const out: { queue: string; symbol: string; file: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.file)) continue;
    seen.add(r.file);
    out.push(r);
  }
  return out;
}
