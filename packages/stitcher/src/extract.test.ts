import { describe, it, expect } from 'vitest';
import { extractQueueGraph } from './extract.js';
import type { ProducerClassInput, WorkerFileInput } from './extract.js';

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
