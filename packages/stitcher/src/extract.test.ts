import { describe, it, expect } from 'vitest';
import { extractQueueGraph, extractCeleryQueueGraph, extractDramatiqQueueGraph } from './extract.js';
import type { ProducerClassInput, WorkerFileInput } from './extract.js';

describe('extractCeleryQueueGraph (HOR-356)', () => {
  const nodes = [
    { name: 'send_email', filePath: 'app/tasks.py', content: '@shared_task\ndef send_email(to):\n    smtp.send(to)' },
    { name: 'generate_report', filePath: 'app/tasks.py', content: '@app.task(bind=True)\ndef generate_report(self):\n    pass' },
    {
      name: 'signup',
      filePath: 'app/views.py',
      content: 'def signup(req):\n    send_email.delay(req.email)\n    generate_report.apply_async()',
    },
    // `.delay()` with no matching @task def — must NOT synthesize a queue.
    { name: 'animate', filePath: 'web/anim.py', content: 'def animate():\n    tween.delay(100)' },
  ];
  const g = extractCeleryQueueGraph(nodes);
  const has = (q: string, p: string | null, w: string | null): boolean =>
    g.edges.some((e) => e.queueName === q && e.producerSymbol === p && e.workerSymbol === w);

  it('links a .delay() producer to its @shared_task worker', () => {
    expect(has('send_email', 'signup', 'send_email')).toBe(true);
  });

  it('links an apply_async() producer to its @app.task worker', () => {
    expect(has('generate_report', 'signup', 'generate_report')).toBe(true);
  });

  it('does not synthesize a queue for a .delay() with no @task definition', () => {
    expect(g.queues).not.toContain('tween');
    expect(g.edges.some((e) => e.queueName === 'tween')).toBe(false);
  });

  it('emits a worker-only edge for a task with no producer', () => {
    const solo = extractCeleryQueueGraph([
      { name: 'cleanup', filePath: 't.py', content: '@shared_task\ndef cleanup():\n    pass' },
    ]);
    expect(solo.edges).toHaveLength(1);
    expect(solo.edges[0]?.queueName).toBe('cleanup');
    expect(solo.edges[0]?.producerSymbol).toBeNull();
    expect(solo.edges[0]?.workerSymbol).toBe('cleanup');
  });

  it('attributes producers to functions, not File nodes', () => {
    const withFile = extractCeleryQueueGraph([
      { name: 'send_email', filePath: 'app/tasks.py', content: '@shared_task\ndef send_email(to):\n    pass' },
      { name: 'signup', filePath: 'app/views.py', content: 'def signup(e):\n    send_email.delay(e)' },
      // File node: name is the filename, content is the whole file (also contains `.delay`).
      { name: 'views.py', filePath: 'app/views.py', content: 'def signup(e):\n    send_email.delay(e)' },
    ]);
    const producers = withFile.edges.map((e) => e.producerSymbol);
    expect(producers).toContain('signup');
    expect(producers).not.toContain('views.py');
  });
});

describe('extractCeleryQueueGraph — huey support (HOR-380)', () => {
  it('links a huey .schedule() producer to its @huey.task worker', () => {
    const g = extractCeleryQueueGraph([
      { name: 'count_beans', filePath: 'app/tasks.py', content: '@huey.task()\ndef count_beans(n):\n    return n' },
      { name: 'enqueue', filePath: 'app/views.py', content: 'def enqueue():\n    count_beans.schedule(args=(10,), delay=5)' },
    ]);
    expect(
      g.edges.some(
        (e) => e.queueName === 'count_beans' && e.producerSymbol === 'enqueue' && e.workerSymbol === 'count_beans',
      ),
    ).toBe(true);
  });

  it('recognizes @db_task and @db_periodic_task as workers', () => {
    const g = extractCeleryQueueGraph([
      { name: 'sync_rows', filePath: 'app/tasks.py', content: '@db_task()\ndef sync_rows():\n    pass' },
      { name: 'nightly', filePath: 'app/tasks.py', content: '@db_periodic_task(crontab(minute=0))\ndef nightly():\n    pass' },
    ]);
    expect(g.queues).toContain('sync_rows');
    expect(g.queues).toContain('nightly');
  });

  it('does not synthesize a queue for a .schedule() with no @task definition', () => {
    const g = extractCeleryQueueGraph([
      { name: 'cron', filePath: 'app/cron.py', content: 'def cron():\n    scheduler.schedule(job)' },
    ]);
    expect(g.queues).not.toContain('scheduler');
    expect(g.edges.some((e) => e.queueName === 'scheduler')).toBe(false);
  });
});

describe('extractCeleryQueueGraph — procrastinate / arq / rq (HOR-380)', () => {
  it('links a procrastinate .defer() producer to its @app.task worker', () => {
    const g = extractCeleryQueueGraph([
      { name: 'sum_task', filePath: 'app/tasks.py', content: '@app.task\ndef sum_task(a, b):\n    return a + b' },
      { name: 'handler', filePath: 'app/views.py', content: 'def handler():\n    sum_task.defer(a=1, b=2)' },
    ]);
    expect(
      g.edges.some(
        (e) => e.queueName === 'sum_task' && e.producerSymbol === 'handler' && e.workerSymbol === 'sum_task',
      ),
    ).toBe(true);
  });

  it('links a procrastinate .defer_async() producer (not mis-parsed as .defer())', () => {
    const g = extractCeleryQueueGraph([
      { name: 'ship_it', filePath: 'app/tasks.py', content: '@app.task\ndef ship_it(id):\n    pass' },
      { name: 'route', filePath: 'app/api.py', content: 'async def route():\n    await ship_it.defer_async(id=7)' },
    ]);
    expect(
      g.edges.some(
        (e) => e.queueName === 'ship_it' && e.producerSymbol === 'route' && e.workerSymbol === 'ship_it',
      ),
    ).toBe(true);
  });

  it('drops rq .enqueue() / arq .enqueue_job() producers that lack a worker decorator', () => {
    // rq/arq register workers by function reference, not a decorator on the def — so there is no
    // task def to anchor the queue, and these producers are correctly dropped (HOR-380 caveat).
    const g = extractCeleryQueueGraph([
      { name: 'plain', filePath: 'app/tasks.py', content: 'def plain():\n    pass' },
      {
        name: 'caller',
        filePath: 'app/views.py',
        content: 'def caller():\n    plain.enqueue()\n    plain.enqueue_job()',
      },
    ]);
    expect(g.queues).not.toContain('plain');
    expect(g.edges.some((e) => e.queueName === 'plain')).toBe(false);
  });
});

describe('extractCeleryQueueGraph — faust / test-unit discipline (HOR-424)', () => {
  it('does not synthesize pseudo-queues from faust @Service.task coroutine methods', () => {
    // faust's queue model is the Kafka topic (`@app.agent`), and its internal service coroutines
    // are decorated with the PascalCase class descriptor `@Service.task` — NOT a Celery task queue.
    // These must never become queues named `_fetcher`/`_flush`/`_commit_handler`.
    const g = extractCeleryQueueGraph([
      {
        name: 'Fetcher',
        filePath: 'faust/transport/consumer.py',
        content:
          'class Fetcher(Service):\n    @Service.task\n    async def _fetcher(self) -> None:\n        pass',
      },
      {
        name: 'Conductor',
        filePath: 'faust/transport/conductor.py',
        content:
          'class Conductor(Service):\n    @Service.task\n    async def _flush(self) -> None:\n        pass\n\n    @Service.task\n    async def _commit_handler(self) -> None:\n        pass',
      },
    ]);
    expect(g.queues).not.toContain('_fetcher');
    expect(g.queues).not.toContain('_flush');
    expect(g.queues).not.toContain('_commit_handler');
    expect(g.queues).toHaveLength(0);
    expect(g.workers).toHaveLength(0);
  });

  it('still matches a real Celery @app.task (lowercase app instance) alongside faust noise', () => {
    const g = extractCeleryQueueGraph([
      { name: 'Fetcher', filePath: 'faust/consumer.py', content: '@Service.task\nasync def _fetcher(self):\n    pass' },
      { name: 'send_email', filePath: 'app/tasks.py', content: '@app.task\ndef send_email(to):\n    pass' },
      { name: 'cleanup', filePath: 'app/tasks.py', content: '@celery.task\ndef cleanup():\n    pass' },
    ]);
    expect(g.queues).toContain('send_email');
    expect(g.queues).toContain('cleanup');
    expect(g.queues).not.toContain('_fetcher');
  });

  it('excludes test functions/files from Celery workers (HOR-424)', () => {
    const g = extractCeleryQueueGraph([
      { name: 'send_email', filePath: 'app/tasks.py', content: '@shared_task\ndef send_email(to):\n    pass' },
      // A test-suite task by function-name convention inside a non-test file.
      { name: 'test_send_email', filePath: 'app/tasks.py', content: '@shared_task\ndef test_send_email():\n    pass' },
      // A task defined in a tests/ file.
      { name: 'fixture_task', filePath: 'tests/conftest.py', content: '@shared_task\ndef fixture_task():\n    pass' },
    ]);
    const workerSymbols = g.workers.map((w) => w.symbol);
    expect(workerSymbols).toContain('send_email');
    expect(workerSymbols).not.toContain('test_send_email');
    expect(workerSymbols).not.toContain('fixture_task');
    expect(g.workers.every((w) => !/(^|\/)tests?\//.test(w.file))).toBe(true);
  });

  it('excludes test functions/files from Celery producers (HOR-424)', () => {
    const g = extractCeleryQueueGraph([
      { name: 'send_email', filePath: 'app/tasks.py', content: '@shared_task\ndef send_email(to):\n    pass' },
      // Real enqueue site.
      { name: 'signup', filePath: 'app/views.py', content: 'def signup(e):\n    send_email.delay(e)' },
      // Test enqueue sites — must not be producers.
      { name: 'test_send_email_enqueues', filePath: 'app/views.py', content: 'def test_send_email_enqueues():\n    send_email.delay("x")' },
      { name: 'check', filePath: 'tests/test_tasks.py', content: 'def check():\n    send_email.delay("y")' },
    ]);
    const producers = g.edges.map((e) => e.producerSymbol);
    expect(producers).toContain('signup');
    expect(producers).not.toContain('test_send_email_enqueues');
    expect(g.edges.some((e) => e.producerFile === 'tests/test_tasks.py')).toBe(false);
  });
});

describe('extractDramatiqQueueGraph (HOR-411)', () => {
  const has = (g: ReturnType<typeof extractDramatiqQueueGraph>, q: string, p: string | null, w: string | null): boolean =>
    g.edges.some((e) => e.queueName === q && e.producerSymbol === p && e.workerSymbol === w);

  it('links a .send() producer to its @actor worker on the default broker queue', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'count_words', filePath: 'app/tasks.py', content: '@actor\ndef count_words(url):\n    pass' },
      { name: 'enqueue', filePath: 'app/views.py', content: 'def enqueue():\n    count_words.send("http://x")' },
    ]);
    // Queue is the broker queue ("default"), NOT the actor/function name.
    expect(g.queues).toEqual(['default']);
    expect(g.queues).not.toContain('count_words');
    expect(has(g, 'default', 'enqueue', 'count_words')).toBe(true);
  });

  it('maps an actor to its explicit queue_name= broker queue', () => {
    const g = extractDramatiqQueueGraph([
      {
        name: 'resize',
        filePath: 'app/tasks.py',
        content: '@dramatiq.actor(queue_name="images", max_retries=3)\ndef resize(path):\n    pass',
      },
      { name: 'upload', filePath: 'app/views.py', content: 'def upload():\n    resize.send(p)' },
    ]);
    expect(g.queues).toEqual(['images']);
    expect(has(g, 'images', 'upload', 'resize')).toBe(true);
  });

  it('recognizes @dramatiq.actor(...) with args as a worker (default queue)', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'resize', filePath: 'app/tasks.py', content: '@dramatiq.actor(max_retries=3)\ndef resize(path):\n    pass' },
    ]);
    expect(g.queues).toEqual(['default']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.queueName).toBe('default');
    expect(g.edges[0]?.producerSymbol).toBeNull();
    expect(g.edges[0]?.workerSymbol).toBe('resize');
  });

  it('matches a multi-line @actor(...) decorator and resolves its queue_name= (HOR-420)', () => {
    const g = extractDramatiqQueueGraph([
      {
        name: 'send_newsletter',
        filePath: 'app/tasks.py',
        content:
          '@dramatiq.actor(\n    queue_name="emails",\n    max_retries=3,\n)\ndef send_newsletter(to):\n    pass',
      },
      { name: 'publish', filePath: 'app/views.py', content: 'def publish():\n    send_newsletter.send("x")' },
    ]);
    // The multi-line decorator must still register the actor and read its broker queue.
    expect(g.queues).toEqual(['emails']);
    expect(has(g, 'emails', 'publish', 'send_newsletter')).toBe(true);
  });

  it('matches a bare multi-line @actor( ) decorator on the default queue (HOR-420)', () => {
    const g = extractDramatiqQueueGraph([
      {
        name: 'resize',
        filePath: 'app/tasks.py',
        content: '@dramatiq.actor(\n    max_retries=3,\n)\ndef resize(path):\n    pass',
      },
    ]);
    expect(g.queues).toEqual(['default']);
    expect(g.workers.map((w) => w.symbol)).toEqual(['resize']);
  });

  it('excludes @actor test defs by name even inside a non-test module node (HOR-420)', () => {
    const g = extractDramatiqQueueGraph([
      // A regular module node (NOT named/pathed as a test) that nonetheless declares a real actor
      // and a dramatiq-style `test_*` actor side by side — the latter must not become a worker.
      {
        name: 'actors',
        filePath: 'app/actors.py',
        content:
          '@actor\ndef count_words(url):\n    pass\n\n@actor\ndef test_count_words_actor():\n    pass',
      },
    ]);
    const workerSymbols = g.workers.map((w) => w.symbol);
    expect(workerSymbols).toContain('count_words');
    expect(workerSymbols).not.toContain('test_count_words_actor');
    expect(g.queues).toEqual(['default']);
  });

  it('does not synthesize a queue for a .send() with no @actor definition', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'notify', filePath: 'app/io.py', content: 'def notify():\n    socket.send(payload)' },
    ]);
    expect(g.queues).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it('excludes test functions/files from producers', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'add', filePath: 'app/tasks.py', content: '@actor\ndef add(x, y):\n    return x + y' },
      // pytest test function (by name) — must not count as a producer.
      {
        name: 'test_actors_can_be_sent_messages',
        filePath: 'app/tasks.py',
        content: 'def test_actors_can_be_sent_messages():\n    add.send(1, 2)',
      },
      // a test file — must not count as a producer either.
      { name: 'check', filePath: 'tests/test_actor.py', content: 'def check():\n    add.send(3, 4)' },
    ]);
    expect(g.edges.some((e) => e.producerSymbol === 'test_actors_can_be_sent_messages')).toBe(false);
    expect(g.edges.some((e) => e.producerFile === 'tests/test_actor.py')).toBe(false);
    // With no real producer left, `add` remains as a worker-only edge on the default queue.
    expect(has(g, 'default', null, 'add')).toBe(true);
  });

  it('drops actor -> actor self-edges (an actor re-enqueueing itself)', () => {
    const g = extractDramatiqQueueGraph([
      {
        name: 'foo',
        filePath: 'app/tasks.py',
        content: '@actor\ndef foo():\n    foo.send()',
      },
    ]);
    // No `foo -> foo` self-edge; falls back to a worker-only edge.
    expect(g.edges.every((e) => !(e.producerSymbol === 'foo' && e.workerSymbol === 'foo'))).toBe(true);
    expect(has(g, 'default', null, 'foo')).toBe(true);
  });

  it('attributes producers to functions, not File nodes', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'add', filePath: 'app/tasks.py', content: '@actor\ndef add(x, y):\n    return x + y' },
      { name: 'enqueue', filePath: 'app/views.py', content: 'def enqueue():\n    add.send(1, 2)' },
      // File node: name is the filename, content is the whole file (also contains `.send`).
      { name: 'views.py', filePath: 'app/views.py', content: 'def enqueue():\n    add.send(1, 2)' },
    ]);
    const producers = g.edges.map((e) => e.producerSymbol);
    expect(producers).toContain('enqueue');
    expect(producers).not.toContain('views.py');
  });

  // --- HOR-411 round 2: worker/producer attribution noise ---

  it('excludes @actor test workers (tests/ + test_*) from the worker list and queues', () => {
    const g = extractDramatiqQueueGraph([
      // Real actor.
      { name: 'count_words', filePath: 'app/tasks.py', content: '@actor\ndef count_words(url):\n    pass' },
      // A test-suite actor by file (tests/) — not topology.
      {
        name: 'test_actor_worker',
        filePath: 'tests/test_actors.py',
        content: '@actor\ndef test_actor_worker():\n    pass',
      },
      // A test-suite actor by function-name convention.
      {
        name: 'test_count_words_actor',
        filePath: 'app/conftest.py',
        content: '@actor\ndef test_count_words_actor():\n    pass',
      },
    ]);
    const workerSymbols = g.workers.map((w) => w.symbol);
    expect(workerSymbols).toContain('count_words');
    expect(workerSymbols).not.toContain('test_actor_worker');
    expect(workerSymbols).not.toContain('test_count_words_actor');
    // A test-only actor never registers, so it isn't a queue/edge either.
    expect(g.workers.every((w) => !/(^|\/)tests?\//.test(w.file))).toBe(true);
    expect(g.edges.some((e) => e.workerSymbol === 'test_actor_worker')).toBe(false);
  });

  it('attributes a producer to the enclosing method, not the Class node name', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'reindex', filePath: 'app/tasks.py', content: '@actor\ndef reindex(doc):\n    pass' },
      // A Class node: `n.name` is the class ("SearchService"), but the real enqueue site is the
      // `schedule_reindex` method. The producer must be the method, never the class name.
      {
        name: 'SearchService',
        filePath: 'app/search/service.py',
        content:
          'class SearchService:\n    def schedule_reindex(self, doc):\n        reindex.send(doc)\n',
      },
    ]);
    expect(has(g, 'default', 'schedule_reindex', 'reindex')).toBe(true);
    expect(g.edges.some((e) => e.producerSymbol === 'SearchService')).toBe(false);
    expect(g.producers.some((p) => p.symbol === 'SearchService')).toBe(false);
  });

  it('drops a class/module-body `.send()` with no enclosing def (arbitrary class/module name)', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'reindex', filePath: 'app/tasks.py', content: '@actor\ndef reindex(doc):\n    pass' },
      // A Class node whose `.send()` sits at class body level — no enclosing `def`, so there is no
      // real call-site function to name. We must NOT report the class ("Results") as the producer.
      {
        name: 'Results',
        filePath: 'app/results/middleware.py',
        content: 'class Results:\n    reindex.send(None)\n',
      },
    ]);
    expect(g.edges.some((e) => e.producerSymbol === 'Results')).toBe(false);
    expect(g.producers.some((p) => p.symbol === 'Results')).toBe(false);
    // The actor is still a real worker on the default queue (worker-only edge).
    expect(has(g, 'default', null, 'reindex')).toBe(true);
  });

  it('handles a mixed dramatiq fixture: workers exclude tests/, producers are real enqueuers', () => {
    const g = extractDramatiqQueueGraph([
      { name: 'send_email', filePath: 'app/tasks.py', content: '@actor\ndef send_email(to):\n    pass' },
      {
        name: 'resize',
        filePath: 'app/tasks.py',
        content: '@dramatiq.actor(queue_name="images")\ndef resize(p):\n    pass',
      },
      // Real enqueue sites (functions/methods).
      {
        name: 'Mailer',
        filePath: 'app/mail/mailer.py',
        content: 'class Mailer:\n    def notify(self, to):\n        send_email.send(to)\n',
      },
      { name: 'handle_upload', filePath: 'app/views.py', content: 'def handle_upload(p):\n    resize.send_with_options(args=(p,))' },
      // Test workers + test producers — all noise.
      {
        name: 'test_send_email',
        filePath: 'tests/test_mail.py',
        content: '@actor\ndef test_worker():\n    pass\n\ndef test_send_email():\n    send_email.send("x")',
      },
    ]);
    const workerSymbols = g.workers.map((w) => w.symbol).sort();
    expect(workerSymbols).toEqual(['resize', 'send_email']);
    expect(g.workers.every((w) => !/(^|\/)tests?\//.test(w.file))).toBe(true);
    const producerSymbols = g.producers.map((p) => p.symbol).sort();
    // Real enqueuers only — the enclosing method/function, no class names, no test files.
    expect(producerSymbols).toEqual(['handle_upload', 'notify']);
    expect(g.producers.every((p) => !/(^|\/)tests?\//.test(p.file))).toBe(true);
    expect(has(g, 'default', 'notify', 'send_email')).toBe(true);
    expect(has(g, 'images', 'handle_upload', 'resize')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Domain-neutral fixtures
// ---------------------------------------------------------------------------

const producerClasses: ProducerClassInput[] = [
  {
    name: 'NotificationService',
    filePath: 'src/notifications/notification.service.ts',
    content: "constructor(@InjectQueue('emails') private readonly q: Queue) {}",
  },
  {
    name: 'ReportService',
    filePath: 'src/reports/report.service.ts',
    content: "constructor(@InjectQueue('reports') private readonly q: Queue) {}",
  },
  {
    name: 'DigestService',
    filePath: 'src/digest/digest.service.ts',
    content:
      "constructor(@InjectQueue('emails') private readonly a: Queue, @InjectQueue('reports') private readonly b: Queue) {}",
  },
];

const workerFiles: WorkerFileInput[] = [
  {
    filePath: 'src/notifications/email.processor.ts',
    content:
      "@Processor('emails', { concurrency: 5 })\nexport class EmailProcessor extends WorkerHost {",
  },
  {
    filePath: 'src/reports/report.processor.ts',
    content: "@Processor('reports')\nexport class ReportProcessor extends WorkerHost {",
  },
];

// ---------------------------------------------------------------------------
// Main graph tests
// ---------------------------------------------------------------------------

describe('extractQueueGraph — main fixtures', () => {
  const g = extractQueueGraph({ producerClasses, workerFiles });

  const has = (q: string, p: string | null, w: string | null) =>
    g.edges.some(
      (e) => e.queueName === q && e.producerSymbol === p && e.workerSymbol === w,
    );

  it('returns sorted unique queue names', () => {
    expect(g.queues).toEqual(['emails', 'reports']);
  });

  it('has 4 edges', () => {
    expect(g.edges.length).toBe(4);
  });

  it('has edge: emails / NotificationService -> EmailProcessor', () => {
    expect(has('emails', 'NotificationService', 'EmailProcessor')).toBe(true);
  });

  it('has edge: emails / DigestService -> EmailProcessor', () => {
    expect(has('emails', 'DigestService', 'EmailProcessor')).toBe(true);
  });

  it('has edge: reports / ReportService -> ReportProcessor', () => {
    expect(has('reports', 'ReportService', 'ReportProcessor')).toBe(true);
  });

  it('has edge: reports / DigestService -> ReportProcessor', () => {
    expect(has('reports', 'DigestService', 'ReportProcessor')).toBe(true);
  });

  it('has 4 producer records (NotificationService, ReportService, DigestService×2)', () => {
    expect(g.producers.length).toBe(4);
  });

  it('has 2 worker records (EmailProcessor, ReportProcessor)', () => {
    expect(g.workers.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Edge-case: worker-only queue (no producer)
// ---------------------------------------------------------------------------

describe('extractQueueGraph — worker-only queue', () => {
  const workerOnlyFiles: WorkerFileInput[] = [
    {
      filePath: 'x.processor.ts',
      content: "@Processor('orphan')\nexport class OrphanProcessor extends WorkerHost {",
    },
  ];

  const g = extractQueueGraph({ producerClasses: [], workerFiles: workerOnlyFiles });

  it('produces exactly one edge', () => {
    expect(g.edges.length).toBe(1);
  });

  it('edge has queueName orphan, null producerSymbol, workerSymbol OrphanProcessor', () => {
    const edge = g.edges[0];
    expect(edge).toBeDefined();
    expect(edge?.queueName).toBe('orphan');
    expect(edge?.producerSymbol).toBeNull();
    expect(edge?.workerSymbol).toBe('OrphanProcessor');
  });
});

// ---------------------------------------------------------------------------
// HOR-341: dynamically-registered queues via `new Queue/Worker(EnumMember)`
// ---------------------------------------------------------------------------

// Mirrors the maison-safqa pattern:
//   - enum ScheduledEvents { SEED_PRODUCTS = 'SEED_PRODUCTS', ... }
//   - producer: getQueue(eventName) → new Queue(eventName) (loop over Object.values)
//   - worker:   for (const eventName of Object.values(ScheduledEvents)) new Worker(eventName, ...)
//   - dispatch: getTaskForEvent → { [ScheduledEvents.X]: () => this.ctrl.method() }
const ENUM_CONTENT = `export enum ScheduledEvents {
  SEED_PRODUCTS = 'SEED_PRODUCTS',
  MANAGE_SALES = 'MANAGE_SALES',
  SYNC_BRAND_FULFILLMENTS = 'SYNC_BRAND_FULFILLMENTS',
}`;

describe('extractQueueGraph — new Worker(EnumMember) member access', () => {
  const g = extractQueueGraph({
    producerClasses: [
      { name: 'EnumsModule', filePath: 'src/types/enums.ts', content: ENUM_CONTENT },
    ],
    workerFiles: [
      {
        filePath: 'src/workers/sales.worker.ts',
        content:
          'const w = new Worker<JobData>(ScheduledEvents.MANAGE_SALES, async (job) => {})',
      },
    ],
  });

  it('resolves the enum member to its string value as the queue name', () => {
    expect(g.queues).toEqual(['MANAGE_SALES']);
  });

  it('emits a worker edge keyed by the resolved value', () => {
    const edge = g.edges.find((e) => e.queueName === 'MANAGE_SALES');
    expect(edge).toBeDefined();
    expect(edge?.workerSymbol).toBe('w');
    expect(edge?.workerFile).toBe('src/workers/sales.worker.ts');
  });
});

describe('extractQueueGraph — Object.values(Enum) worker loop fan-out', () => {
  const g = extractQueueGraph({
    producerClasses: [
      { name: 'EnumsModule', filePath: 'src/types/enums.ts', content: ENUM_CONTENT },
    ],
    workerFiles: [
      {
        filePath: 'src/workers/worker-manager.ts',
        content:
          'for (const eventName of Object.values(ScheduledEvents)) {\n' +
          '  const worker = new Worker<ScheduledJobData>(eventName, async (job) => {})\n' +
          '}',
      },
    ],
  });

  it('fans the generic loop out to one queue per enum member', () => {
    expect(g.queues).toEqual([
      'MANAGE_SALES',
      'SEED_PRODUCTS',
      'SYNC_BRAND_FULFILLMENTS',
    ]);
  });

  it('emits a worker edge for every member', () => {
    for (const q of ['MANAGE_SALES', 'SEED_PRODUCTS', 'SYNC_BRAND_FULFILLMENTS']) {
      const edge = g.edges.find((e) => e.queueName === q);
      expect(edge, `edge for ${q}`).toBeDefined();
      expect(edge?.workerSymbol).toBe('worker');
    }
  });
});

describe('extractQueueGraph — dispatch table links queue to handler', () => {
  const dispatchContent = `getTaskForEvent(eventName) {
  const taskMap = {
    [ScheduledEvents.SEED_PRODUCTS]: () => this.productController.seedProducts(),
    [ScheduledEvents.MANAGE_SALES]: (marketType) => this.saleController.manageSalesForMarket(marketType),
    [ScheduledEvents.SYNC_BRAND_FULFILLMENTS]: () => this.orderController.syncBrandFulfillments(),
  }
  return taskMap[eventName]
}`;

  const g = extractQueueGraph({
    producerClasses: [
      { name: 'EnumsModule', filePath: 'src/types/enums.ts', content: ENUM_CONTENT },
      {
        name: 'SchedulerController',
        filePath: 'src/controllers/scheduler.controller.ts',
        content: dispatchContent,
      },
    ],
    workerFiles: [
      {
        filePath: 'src/workers/worker-manager.ts',
        content:
          'for (const eventName of Object.values(ScheduledEvents)) {\n' +
          '  const worker = new Worker(eventName, async (job) => {})\n' +
          '}',
      },
    ],
  });

  it('links each queue to its dispatch-table handler symbol', () => {
    const hasHandler = (q: string, handler: string) =>
      g.edges.some((e) => e.queueName === q && e.workerSymbol === handler);
    expect(hasHandler('SEED_PRODUCTS', 'seedProducts')).toBe(true);
    expect(hasHandler('MANAGE_SALES', 'manageSalesForMarket')).toBe(true);
    expect(hasHandler('SYNC_BRAND_FULFILLMENTS', 'syncBrandFulfillments')).toBe(true);
  });

  it('records the handler file on the linked worker edge', () => {
    const edge = g.edges.find(
      (e) => e.queueName === 'SYNC_BRAND_FULFILLMENTS' && e.workerSymbol === 'syncBrandFulfillments',
    );
    expect(edge?.workerFile).toBe('src/controllers/scheduler.controller.ts');
  });

  it('still keeps the generic Worker edge alongside the handler edges', () => {
    const generic = g.edges.filter((e) => e.workerSymbol === 'worker');
    expect(generic.length).toBe(3);
  });
});

// Real dispatch tables wrap the arrow body onto the next line — the rhs must span past the
// newline to the entry's trailing comma (HOR-341, found dogfooding maison-safqa).
describe('extractQueueGraph — dispatch handler wrapped across lines (HOR-341)', () => {
  const wrappedDispatch = `getTaskForEvent(eventName) {
  const taskMap = {
    [ScheduledEvents.SEED_PRODUCTS]: () =>
      this.productController.seedProducts(),
    [ScheduledEvents.SYNC_BRAND_FULFILLMENTS]: () =>
      this.orderController.syncBrandFulfillments(),
  }
  return taskMap[eventName]
}`;
  const g = extractQueueGraph({
    producerClasses: [
      { name: 'EnumsModule', filePath: 'src/types/enums.ts', content: ENUM_CONTENT },
      {
        name: 'SchedulerController',
        filePath: 'src/controllers/scheduler.controller.ts',
        content: wrappedDispatch,
      },
    ],
    workerFiles: [],
  });

  it('resolves a handler whose arrow body is on the next line', () => {
    const hasHandler = (q: string, handler: string) =>
      g.edges.some((e) => e.queueName === q && e.workerSymbol === handler);
    expect(hasHandler('SYNC_BRAND_FULFILLMENTS', 'syncBrandFulfillments')).toBe(true);
    expect(hasHandler('SEED_PRODUCTS', 'seedProducts')).toBe(true);
  });
});

describe('extractQueueGraph — new Queue(EnumMember) producer + dispatch worker', () => {
  const g = extractQueueGraph({
    producerClasses: [
      { name: 'EnumsModule', filePath: 'src/types/enums.ts', content: ENUM_CONTENT },
      {
        name: 'OrderProducer',
        filePath: 'src/producers/order.producer.ts',
        content:
          'const q = new Queue(ScheduledEvents.SYNC_BRAND_FULFILLMENTS, { connection })',
      },
      {
        name: 'SchedulerController',
        filePath: 'src/controllers/scheduler.controller.ts',
        content:
          '{ [ScheduledEvents.SYNC_BRAND_FULFILLMENTS]: () => this.orderController.syncBrandFulfillments() }',
      },
    ],
    workerFiles: [],
  });

  it('joins the enum-member producer to the dispatch handler worker', () => {
    const edge = g.edges.find(
      (e) =>
        e.queueName === 'SYNC_BRAND_FULFILLMENTS' &&
        e.producerSymbol === 'q' &&
        e.workerSymbol === 'syncBrandFulfillments',
    );
    expect(edge).toBeDefined();
    expect(edge?.producerFile).toBe('src/producers/order.producer.ts');
    expect(edge?.workerFile).toBe('src/controllers/scheduler.controller.ts');
  });
});

describe('extractQueueGraph — implicit (un-valued) enum member fallback', () => {
  const g = extractQueueGraph({
    producerClasses: [
      {
        name: 'EnumsModule',
        filePath: 'src/types/enums.ts',
        content: 'enum Jobs {\n  ALPHA,\n  BETA,\n}',
      },
    ],
    workerFiles: [
      {
        filePath: 'src/worker.ts',
        content: 'new Worker(Jobs.ALPHA, async () => {})',
      },
    ],
  });

  it('falls back to the member name when the enum has no string value', () => {
    expect(g.queues).toEqual(['ALPHA']);
  });
});

describe('extractQueueGraph — unresolvable enum member does not regress literals', () => {
  const g = extractQueueGraph({
    producerClasses: [
      { name: 'LiteralProducer', filePath: 'src/p.ts', content: "new Queue('emails')" },
    ],
    workerFiles: [
      // Enum is never declared anywhere → member access is unresolvable and skipped.
      { filePath: 'src/w.ts', content: 'new Worker(MissingEnum.GHOST, async () => {})' },
      { filePath: 'src/literal.worker.ts', content: "@Processor('emails')\nexport class EmailProcessor {}" },
    ],
  });

  it('emits only the resolvable literal queue', () => {
    expect(g.queues).toEqual(['emails']);
  });

  it('still links the literal producer to the literal worker', () => {
    const edge = g.edges.find((e) => e.queueName === 'emails');
    expect(edge?.producerSymbol).toBe('LiteralProducer');
    expect(edge?.workerSymbol).toBe('EmailProcessor');
  });
});
