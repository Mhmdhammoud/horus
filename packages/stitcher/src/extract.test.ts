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
