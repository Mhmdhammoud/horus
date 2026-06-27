/**
 * Pure queue-graph extraction — no IO. Parses BullMQ/NestJS queue-name literals out of
 * Source-intelligence symbol "content" and joins producers to workers on the queue-name string.
 *
 * Idioms supported, generically (no project-specific names):
 *  - NestJS @nestjs/bull(mq): `@InjectQueue('<name>')` producers, class-level
 *    `@Processor('<name>')` workers (inline string literals).
 *  - Raw bullmq: `new Queue(<arg>)` / `new Worker(<arg>)` where `<arg>` is a string
 *    literal OR a constant (e.g. `const X_QUEUE_NAME = 'name'`) resolved across files.
 *    A module that DECLARES a queue-name constant is treated as that queue's producer
 *    (its definition site), which links it to the `new Worker(...)` consumer.
 *  - Dynamically-registered queues (HOR-341): `new Queue(<EnumMember>)` /
 *    `new Worker(<EnumMember>)` resolves the enum member (e.g. `ScheduledEvents.MANAGE_SALES`)
 *    to its string value from the enum declaration. When the `new Queue/Worker(<loopVar>)`
 *    is driven by `for (const x of Object.values(SomeEnum))`, it fans out to ONE queue per
 *    enum member. Where a dispatch table maps the enum member to a handler
 *    (`[SomeEnum.MEMBER]: () => this.ctrl.method()`), the queue is linked to that handler
 *    as a worker, so the engine can map the runtime queue to owning code.
 *
 * Resolution is best-effort and additive: if a value can't be resolved statically we fall
 * back to the existing behavior (literal-named queues never regress).
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
// `[<ident> =] new Queue|Worker [<T>] ( <arg>` where arg is a literal, an identifier,
// or a member access (e.g. `ScheduledEvents.MANAGE_SALES`).
const NEW_BULL_RE =
  /(?:(\w+)\s*[:=]\s*)?new\s+(Queue|Worker)\s*(?:<[^>]*>)?\s*\(\s*(['"][^'"]+['"]|[A-Za-z_$][\w$.]*)/g;
// A queue-name constant: identifier contains QUEUE/Queue — its module is the producer.
const QUEUE_NAME_CONST_RE =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*(?:QUEUE|Queue)[\w$]*)\s*=\s*['"]([^'"]+)['"]/g;

// --- Enum / indirection patterns (HOR-341) ---
// `enum Name { ... }` — captures the enum body for member parsing. `[const ]enum`.
const ENUM_DECL_RE = /(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/g;
// A single enum member inside an enum body: `MEMBER = 'value'` (string-valued) or `MEMBER`
// (implicit — value defaults to the member name, which is the common BullMQ convention).
const ENUM_MEMBER_RE = /([A-Za-z_$][\w$]*)\s*(?:=\s*(['"])([^'"]*)\2)?/g;
// `for (const x of Object.values(Enum))` — captures the loop var and the enum name so a
// `new Queue/Worker(x)` inside that loop fans out to every enum member.
const OBJECT_VALUES_LOOP_RE =
  /for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+Object\.values\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
// A dispatch-table entry mapping an enum member to a handler:
//   `[Enum.MEMBER]: () => this.ctrl.method(...)`  or  `[Enum.MEMBER]: handlerFn`
// Captures the member-access key and a best-effort handler symbol (method name, or fn name).
// The rhs runs to the entry's trailing comma/brace (NOT the first newline) so a handler that
// wraps onto the next line — `[Enum.MEMBER]: () =>\n  this.ctrl.method()` — still resolves.
const DISPATCH_ENTRY_RE =
  /\[\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\]\s*:\s*([^,}]+)/g;

function baseName(filePath: string): string {
  const parts = filePath.split('/');
  const last = parts[parts.length - 1] ?? filePath;
  return last.replace(/\.[jt]sx?$/, '');
}

/** Parsed enums: enum name -> ordered list of `{ member, value }`. */
type EnumMap = Map<string, { member: string; value: string }[]>;

/** Build a map of all enum declarations found across every content unit. */
function buildEnumMap(contents: string[]): EnumMap {
  const enums: EnumMap = new Map();
  for (const content of contents) {
    for (const decl of content.matchAll(ENUM_DECL_RE)) {
      const enumName = decl[1];
      const body = decl[2] ?? '';
      if (!enumName || enums.has(enumName)) continue;
      const members: { member: string; value: string }[] = [];
      for (const m of body.matchAll(ENUM_MEMBER_RE)) {
        const member = m[1];
        // Skip empties produced by the optional-group regex between commas.
        if (!member) continue;
        // String-valued enum members get their literal; implicit members fall back to the
        // member name (the dominant convention for queue-name enums, e.g. FOO = 'FOO').
        const value = m[3] !== undefined ? m[3] : member;
        members.push({ member, value });
      }
      if (members.length) enums.set(enumName, members);
    }
  }
  return enums;
}

/** Resolve an `EnumName.MEMBER` member access to its string value via the enum map. */
function resolveEnumMember(ref: string, enums: EnumMap): string | null {
  const dot = ref.indexOf('.');
  if (dot < 0) return null;
  const enumName = ref.slice(0, dot);
  const member = ref.slice(dot + 1);
  const members = enums.get(enumName);
  if (!members) return null;
  return members.find((e) => e.member === member)?.value ?? null;
}

/**
 * Resolve a `new Queue/Worker` argument to one or more queue names.
 *  - string literal               -> [literal]
 *  - `EnumName.MEMBER`            -> [enum member value]
 *  - constant identifier          -> [constant value]
 *  - loop var bound to Object.values(Enum) -> [all enum member values]
 *  - otherwise                    -> [] (unresolved; caller falls back)
 */
function resolveArg(
  raw: string,
  constMap: Map<string, string>,
  enums: EnumMap,
  loopVarEnums: Map<string, string>,
): string[] {
  const arg = raw.trim();
  if (arg.startsWith('"') || arg.startsWith("'")) {
    return [arg.slice(1, -1)];
  }
  // Member access: `ScheduledEvents.MANAGE_SALES`.
  if (arg.includes('.')) {
    const value = resolveEnumMember(arg, enums);
    return value !== null ? [value] : [];
  }
  // Loop var driven by `for (const arg of Object.values(Enum))` — fan out to all members.
  const loopEnum = loopVarEnums.get(arg);
  if (loopEnum) {
    const members = enums.get(loopEnum);
    if (members) return members.map((e) => e.value);
  }
  // Cross-file constant (e.g. `const X_QUEUE_NAME = 'name'`).
  const constValue = constMap.get(arg);
  return constValue !== undefined ? [constValue] : [];
}

/**
 * Build a per-content lookup of loop-variable -> enum name from
 * `for (const x of Object.values(Enum))`. Scoped to the content unit it was found in so a
 * loop var in one file doesn't leak into another.
 */
function loopVarEnumsFor(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of content.matchAll(OBJECT_VALUES_LOOP_RE)) {
    const loopVar = m[1];
    const enumName = m[2];
    if (loopVar && enumName) map.set(loopVar, enumName);
  }
  return map;
}

/**
 * Extract dispatch-table handler links: `enumValue -> handlerSymbol` keyed by the resolved
 * enum-member value. e.g. `[ScheduledEvents.SYNC_BRAND_FULFILLMENTS]: () => this.orderController.syncBrandFulfillments()`
 * yields `'SYNC_BRAND_FULFILLMENTS' -> 'syncBrandFulfillments'`.
 */
function extractDispatchHandlers(
  content: string,
  enums: EnumMap,
): { value: string; handler: string }[] {
  const out: { value: string; handler: string }[] = [];
  for (const m of content.matchAll(DISPATCH_ENTRY_RE)) {
    const enumName = m[1];
    const member = m[2];
    const rhs = (m[3] ?? '').trim();
    if (!enumName || !member) continue;
    const value = resolveEnumMember(`${enumName}.${member}`, enums);
    if (value === null) continue;
    const handler = handlerSymbolFromExpr(rhs);
    if (handler) out.push({ value, handler });
  }
  return out;
}

/**
 * Best-effort handler symbol from a dispatch RHS expression:
 *  - `() => this.ctrl.method(...)`  -> `method`
 *  - `() => freeFn(...)`            -> `freeFn`
 *  - `handlerFn`                    -> `handlerFn`
 *  - `this.ctrl.method`            -> `method`
 */
function handlerSymbolFromExpr(expr: string): string | null {
  // Last `.method(` call in the expression (handles `this.ctrl.method(`).
  const call = expr.match(/([A-Za-z_$][\w$]*)\s*\(/);
  if (call?.[1]) return call[1];
  // Bare member access `this.ctrl.method` or `a.b.c` -> last segment.
  const member = expr.match(/(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)/);
  if (member?.[1]) return member[1];
  // Bare identifier reference.
  const ident = expr.match(/^([A-Za-z_$][\w$]*)$/);
  if (ident?.[1]) return ident[1];
  return null;
}

export function extractQueueGraph(input: {
  producerClasses: ProducerClassInput[];
  workerFiles: WorkerFileInput[];
}): QueueGraph {
  const allContent = [
    ...input.producerClasses.map((p) => p.content),
    ...input.workerFiles.map((w) => w.content),
  ];

  // Global constant map (IDENT -> literal) from every unit's content.
  const constMap = new Map<string, string>();
  for (const content of allContent) {
    for (const m of content.matchAll(CONST_DECL_RE)) {
      const ident = m[1];
      const value = m[2];
      if (ident && value && !constMap.has(ident)) constMap.set(ident, value);
    }
  }

  // Global enum map (Enum.MEMBER -> value) — declarations can live in any indexed unit.
  const enums = buildEnumMap(allContent);

  // Dispatch handlers (resolved enum value -> handler symbol). Collected globally because the
  // dispatch table often lives in a different file from the `new Worker(...)` site.
  const dispatchHandlers: { value: string; handler: string; file: string }[] = [];
  for (const unit of [...input.producerClasses, ...input.workerFiles]) {
    const file = 'filePath' in unit ? unit.filePath : '';
    for (const h of extractDispatchHandlers(unit.content, enums)) {
      dispatchHandlers.push({ value: h.value, handler: h.handler, file });
    }
  }

  const producers: { queue: string; symbol: string; file: string }[] = [];
  for (const pc of input.producerClasses) {
    const loopVarEnums = loopVarEnumsFor(pc.content);
    // NestJS @InjectQueue('name')
    for (const m of pc.content.matchAll(INJECT_QUEUE_RE)) {
      const queue = m[1] ?? '';
      if (queue) producers.push({ queue, symbol: pc.name, file: pc.filePath });
    }
    // Raw `new Queue(<arg>)` — may resolve to several queues (enum fan-out).
    for (const m of pc.content.matchAll(NEW_BULL_RE)) {
      if (m[2] !== 'Queue') continue;
      const queues = resolveArg(m[3] ?? '', constMap, enums, loopVarEnums);
      for (const queue of queues) {
        producers.push({
          queue,
          symbol: (m[1] ?? pc.name) || baseName(pc.filePath),
          file: pc.filePath,
        });
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
    const loopVarEnums = loopVarEnumsFor(wf.content);
    // NestJS class-level @Processor('name')
    for (const m of wf.content.matchAll(PROCESSOR_RE)) {
      const queue = m[1] ?? '';
      const className = m[2] ?? '';
      if (queue) workers.push({ queue, symbol: className, file: wf.filePath });
    }
    // Raw `new Worker(<arg>)` — may resolve to several queues (enum fan-out).
    for (const m of wf.content.matchAll(NEW_BULL_RE)) {
      if (m[2] !== 'Worker') continue;
      const queues = resolveArg(m[3] ?? '', constMap, enums, loopVarEnums);
      for (const queue of queues) {
        workers.push({
          queue,
          symbol: m[1] ?? baseName(wf.filePath),
          file: wf.filePath,
        });
      }
    }
  }

  // Dispatch-table handlers become workers for their queue: the handler is the owning code
  // the runtime queue ultimately runs. This links e.g. `SYNC_BRAND_FULFILLMENTS` to
  // `syncBrandFulfillments` even though the `new Worker(eventName)` is generic.
  for (const h of dispatchHandlers) {
    workers.push({ queue: h.value, symbol: h.handler, file: h.file });
  }

  const queues = [...new Set([...producers, ...workers].map((r) => r.queue))].sort();

  const edges: SynthEdge[] = [];
  for (const q of queues) {
    // Dedup producers/workers per queue by symbol+file so repeated matches and the generic
    // `new Worker(loopVar)` fan-out + dispatch handlers don't multiply edges unnaturally.
    const P = dedupeBySymbolFile(producers.filter((p) => p.queue === q));
    const W = dedupeBySymbolFile(workers.filter((w) => w.queue === q));
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

// --- Celery (Python) patterns (HOR-356) ---
// A Python task-queue worker def: a Celery `@task`/`@shared_task`/`@app.task`/`@celery.task`
// OR a huey `@huey.task`/`@db_task`/`@db_periodic_task` decorator (optionally with args + stacked
// decorators) directly on a `def`. The task name is the function name — what `.delay()`/
// `.apply_async()`/`.schedule()` call sites reference (HOR-356/380). Captures the def name.
// The `(?:[\w]+\.)*` prefix already covers the `huey.`/`app.` qualifier; db_task/db_periodic_task
// are huey-specific names the Celery set missed.
const CELERY_TASK_DEF_RE =
  /@(?:[\w]+\.)*(?:shared_task|db_periodic_task|periodic_task|db_task|task)\b[^\n]*(?:\n[ \t]*@[^\n]*)*\n[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/g;
// An enqueue/producer call site: Celery `<task>.delay(`/`<task>.apply_async(` or huey
// `<task>.schedule(` (HOR-380). Captures the immediate identifier before the call (the task
// name), e.g. `tasks.send_email.delay(` -> `send_email`. `.schedule(` is broad, but the
// taskQueues filter keeps a producer only when it names a real @task def, so non-task
// `.schedule(` calls (cron/APScheduler) are dropped.
const CELERY_ENQUEUE_RE = /([A-Za-z_]\w*)\s*\.\s*(?:delay|apply_async|schedule)\s*\(/g;

export interface CeleryNodeInput {
  name: string;
  filePath: string;
  content: string;
}

/**
 * Pure Celery queue-graph extraction. A `@task def foo` is the worker for task "foo"; a
 * `foo.delay(...)` / `foo.apply_async(...)` call site is a producer. Edges are only emitted
 * for tasks that have a real `@task` definition, so a stray `.delay()` from an unrelated
 * library (e.g. lodash, animation code) never synthesizes a phantom queue.
 */
export function extractCeleryQueueGraph(nodes: CeleryNodeInput[]): QueueGraph {
  const producers: { queue: string; symbol: string; file: string }[] = [];
  const workers: { queue: string; symbol: string; file: string }[] = [];

  // A File node's name is the filename (e.g. `views.py`); its content also contains the
  // function bodies, so it double-matches `.delay()` already attributed to the function node.
  // Skip producer attribution from File nodes so the producer symbol is the function, not the
  // file (workers are unaffected — they derive their symbol from the `def` name, not n.name).
  const FILE_NODE_RE = /\.(py|pyi|js|jsx|ts|tsx|mjs|cjs)$/i;

  for (const n of nodes) {
    for (const m of n.content.matchAll(CELERY_TASK_DEF_RE)) {
      const task = m[1];
      if (task) workers.push({ queue: task, symbol: task, file: n.filePath });
    }
    if (FILE_NODE_RE.test(n.name)) continue;
    for (const m of n.content.matchAll(CELERY_ENQUEUE_RE)) {
      const task = m[1];
      if (task) producers.push({ queue: task, symbol: n.name || baseName(n.filePath), file: n.filePath });
    }
  }

  // Only tasks with a real @task definition are queues — drops `.delay()` false positives.
  const taskQueues = new Set(workers.map((w) => w.queue));
  const queues = [...taskQueues].sort();
  const edges: SynthEdge[] = [];
  for (const q of queues) {
    const P = dedupeBySymbolFile(producers.filter((p) => p.queue === q));
    const W = dedupeBySymbolFile(workers.filter((w) => w.queue === q));
    if (P.length) {
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
    } else {
      for (const w of W) {
        edges.push({
          queueName: q,
          producerSymbol: null,
          producerFile: null,
          workerSymbol: w.symbol,
          workerFile: w.file,
        });
      }
    }
  }

  return {
    queues,
    producers: producers.filter((p) => taskQueues.has(p.queue)),
    workers,
    edges,
  };
}

/**
 * Dedup queue rows by symbol+file. Previously keyed by file alone, but enum fan-out and
 * dispatch tables can legitimately yield several distinct symbols per file (e.g. a generic
 * `new Worker(loopVar)` worker AND named dispatch handlers), so we keep symbol in the key.
 */
function dedupeBySymbolFile(
  rows: { queue: string; symbol: string; file: string }[],
): { queue: string; symbol: string; file: string }[] {
  const seen = new Set<string>();
  const out: { queue: string; symbol: string; file: string }[] = [];
  for (const r of rows) {
    const key = `${r.symbol} ${r.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
