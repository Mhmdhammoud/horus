/**
 * HOR-32 — Unit tests for renderOnboarding (pure, no I/O).
 */

import { describe, it, expect } from 'vitest';
import type { OnboardingGuide } from './onboard.js';
import { renderOnboarding } from './render-onboard.js';

// ---------------------------------------------------------------------------
// Synthetic fixture
// ---------------------------------------------------------------------------

function makeGuide(): OnboardingGuide {
  return {
    area: 'payments',
    architecture: {
      nodeStats: [{ label: 'File', count: 42 }],
      subsystems: [{ name: 'billing-core', members: 18 }],
      asyncBoundaries: [
        {
          queueName: 'invoice-queue',
          producers: ['InvoiceService'],
          workers: ['InvoiceWorker'],
        },
      ],
      keyFlows: ['checkout-flow'],
      externalSystems: [{ name: 'stripe', files: 5 }],
      fragile: { deadCode: 3, highCouplingPairs: 7 },
      summary: '1 subsystems, 1 async queue boundaries, 1 external systems, 3 dead-code symbols.',
    },
    ownership: {
      query: 'payments',
      symbol: null,
      file: 'src/billing/invoice.ts',
      contributors: [
        {
          author: 'alice@example.com',
          commits: 12,
          firstDate: '2024-01-10',
          lastDate: '2024-05-01',
        },
      ],
      likelyMaintainer: 'alice@example.com',
      maintainerShare: 0.8,
      mostActiveRecent: 'alice@example.com',
      confidence: 0.8,
      evidence: ['12 of 15 commits to src/billing/invoice.ts'],
      note: 'Estimate from git commit history only.',
    },
    pastIncidents: [
      {
        id: 'inv-001',
        title: 'Invoice worker stalled on large batch',
        createdAt: '2024-04-15T10:30:00.000Z',
      },
    ],
    summary:
      'Onboarding for "payments": 1 subsystems (largest billing-core), 1 async queue boundaries, 1 external systems, 1 past investigation(s) on record.',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderOnboarding', () => {
  it('contains all five required section headers', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);

    expect(output).toContain('## How this system works');
    expect(output).toContain('## Critical paths');
    expect(output).toContain('## What usually breaks');
    expect(output).toContain('## Who owns this area');
    expect(output).toContain('## Past incidents');
  });

  it('includes the subsystem name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('billing-core');
  });

  it('includes the queue name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('invoice-queue');
  });

  it('includes the maintainer name', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('alice@example.com');
  });

  it('includes the past incident title', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('Invoice worker stalled on large batch');
  });

  it('starts with the onboarding title including area', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('# Onboarding: payments');
  });

  it('shows the summary line', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('Onboarding for "payments"');
  });

  it('renders "none on record" when there are no incidents', () => {
    const guide = makeGuide();
    guide.pastIncidents = [];
    const output = renderOnboarding(guide);
    expect(output).toContain('_none on record_');
  });

  it('renders dim ownership note when ownership is null', () => {
    const guide = makeGuide();
    guide.ownership = null;
    const output = renderOnboarding(guide);
    expect(output).toContain('horus owner <symbol>');
  });

  it('includes the closing deterministic note', () => {
    const guide = makeGuide();
    const output = renderOnboarding(guide);
    expect(output).toContain('deterministic, no AI');
  });
});
