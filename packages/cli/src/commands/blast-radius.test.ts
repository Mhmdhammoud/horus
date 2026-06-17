/**
 * HOR-209 — `horus blast-radius --ai` tests.
 *
 * Tests cover:
 * - The AI contract string describes all required output sections
 * - The prompt shape carries the BlastRadiusReport as evidence with grounding rules
 * - userIntent (query) appears in the prompt
 * - Output contract sections flow through to the model prompt
 */

import { describe, it, expect } from 'vitest';
import { buildInterpretationPrompt } from '@horus/ai';
import { BLAST_RADIUS_AI_CONTRACT } from './blast-radius.js';

const SAMPLE_REPORT = {
  seed: {
    id: 'sym:workers:ZohoSyncWorker',
    name: 'ZohoSyncWorker',
    filePath: 'src/workers/zoho-sync.worker.ts',
    startLine: 10,
  },
  upstream: [
    { id: 'sym:services:ZohoService', name: 'ZohoService', filePath: 'src/services/zoho.service.ts' },
  ],
  downstream: [
    {
      depth: 1,
      symbols: [
        { id: 'sym:controllers:SaleController', name: 'SaleController', filePath: 'src/controllers/sale.controller.ts' },
      ],
    },
  ],
  asyncUpstream: [],
  asyncDownstream: [
    { queueName: 'zoho-sync-queue', counterpart: 'ZohoQueueProducer', counterpartFile: 'src/producers/zoho.producer.ts' },
  ],
  blastRadius: 5,
  criticality: 'high',
  summary: 'ZohoSyncWorker directly affects 5 symbols across 2 depth levels.',
  note: 'This is a graph-based estimate — confirm with logs before making changes.',
};

describe('BLAST_RADIUS_AI_CONTRACT (HOR-209)', () => {
  it('describes all required output sections', () => {
    expect(BLAST_RADIUS_AI_CONTRACT).toContain('Evidence used');
    expect(BLAST_RADIUS_AI_CONTRACT).toContain('Likely impact');
    expect(BLAST_RADIUS_AI_CONTRACT).toContain('Containment ideas');
    expect(BLAST_RADIUS_AI_CONTRACT).toContain('Confidence');
    expect(BLAST_RADIUS_AI_CONTRACT).toContain('Next checks');
  });

  it('is a non-empty string', () => {
    expect(typeof BLAST_RADIUS_AI_CONTRACT).toBe('string');
    expect(BLAST_RADIUS_AI_CONTRACT.length).toBeGreaterThan(0);
  });
});

describe('buildInterpretationPrompt for blast-radius (HOR-209)', () => {
  it('prompt contains the command name and blast-radius promptKind', () => {
    const prompt = buildInterpretationPrompt({
      command: 'blast-radius',
      userIntent: 'query: ZohoSyncWorker',
      evidence: SAMPLE_REPORT,
      promptKind: 'blast-radius',
      outputContract: BLAST_RADIUS_AI_CONTRACT,
    });

    expect(prompt).toContain('blast-radius');
  });

  it('prompt serializes BlastRadiusReport — seed name and async boundary visible to model', () => {
    const prompt = buildInterpretationPrompt({
      command: 'blast-radius',
      userIntent: 'query: ZohoSyncWorker',
      evidence: SAMPLE_REPORT,
      promptKind: 'blast-radius',
      outputContract: BLAST_RADIUS_AI_CONTRACT,
    });

    expect(prompt).toContain('ZohoSyncWorker');
    expect(prompt).toContain('zoho-sync-queue');
    expect(prompt).toContain('ZohoService');
    expect(prompt).toContain('high'); // criticality
  });

  it('prompt includes grounding rules — model must not invent dependencies', () => {
    const prompt = buildInterpretationPrompt({
      command: 'blast-radius',
      evidence: SAMPLE_REPORT,
      promptKind: 'blast-radius',
      outputContract: BLAST_RADIUS_AI_CONTRACT,
    });

    expect(prompt).toContain('Do not invent files');
    expect(prompt).toContain('Use only the evidence provided above');
  });

  it('includes userIntent (query) when provided', () => {
    const prompt = buildInterpretationPrompt({
      command: 'blast-radius',
      userIntent: 'query: ZohoSyncWorker',
      evidence: SAMPLE_REPORT,
      promptKind: 'blast-radius',
      outputContract: BLAST_RADIUS_AI_CONTRACT,
    });

    expect(prompt).toContain('query: ZohoSyncWorker');
  });

  it('output contract sections flow through to the model prompt', () => {
    const prompt = buildInterpretationPrompt({
      command: 'blast-radius',
      evidence: SAMPLE_REPORT,
      promptKind: 'blast-radius',
      outputContract: BLAST_RADIUS_AI_CONTRACT,
    });

    expect(prompt).toContain('Likely impact');
    expect(prompt).toContain('Containment ideas');
    expect(prompt).toContain('async boundaries');
  });
});
