import { describe, it, expect } from 'vitest';
import {
  selectHintMatchedSignal,
  distinctiveHintTokens,
  type SignalLike,
} from './hint-matched-signal.js';

// The exact buckets a warn+text ES query returns for "sale link not found" on maison
// (observed live during HOR-453 diagnosis). WARN998 is the loud unrelated "not found".
const MAISON_SALE_BUCKETS: SignalLike[] = [
  { key: 'WARN998', count: 28792, message: 'Product not found.' },
  { key: 'SALE_028', count: 14895, message: 'Sale with link not found' },
  { key: 'WARN112_02', count: 338, message: 'Brand not found.' },
  { key: 'WARN12_02', count: 127, message: 'Product not found.' },
  { key: 'GAIA039', count: 3, message: 'Product found by handle but gaia_sku mismatch' },
];

describe('distinctiveHintTokens', () => {
  it('keeps domain words, drops generic e-commerce/incident noise + short tokens', () => {
    const d = distinctiveHintTokens(['sale', 'links', 'broken', 'not', 'found', 'product', 'abc']);
    expect(d).toContain('sale');
    expect(d).toContain('links');
    expect(d).not.toContain('broken'); // generic
    expect(d).not.toContain('found'); // generic
    expect(d).not.toContain('product'); // generic
    expect(d).not.toContain('not'); // generic
    expect(d).not.toContain('abc'); // < 4 chars
  });
});

describe('selectHintMatchedSignal (HOR-453 precision gate)', () => {
  it('picks SALE_028 for a "sale links" hint and REJECTS the louder WARN998', () => {
    const hit = selectHintMatchedSignal(MAISON_SALE_BUCKETS, ['sale', 'links', 'broken']);
    expect(hit).not.toBeNull();
    expect(hit!.code).toBe('SALE_028');
    expect(hit!.via).toBe('code'); // matched via event_code segment "sale"
  });

  it('rejects the attempt-1 false positive: PRS_PRD03 must NOT match an emoda hint', () => {
    const buckets: SignalLike[] = [
      { key: 'PRS_PRD03', count: 108, message: 'PrestaShop product sync error' },
      { key: 'EMODA_011_03', count: 52, message: 'Fetch products error' },
    ];
    const hit = selectHintMatchedSignal(buckets, ['fetching', 'products', 'emoda', 'failing']);
    // "product"/"fetch"/"failing" are generic → only "emoda" is distinctive.
    expect(hit?.code).toBe('EMODA_011_03'); // EMODA_011_03 code segment "emoda" matches
    expect(hit?.code).not.toBe('PRS_PRD03');
  });

  it('matches BRAND_API_002A on a "brand api key" hint via code', () => {
    const buckets: SignalLike[] = [
      { key: 'BRAND_API_002A', count: 11, message: 'Brand API missing API key.' },
      { key: 'WARN998', count: 28792, message: 'Product not found.' },
    ];
    const hit = selectHintMatchedSignal(buckets, ['brand', 'missing', 'key']);
    expect(hit?.code).toBe('BRAND_API_002A');
  });

  it('returns null when nothing distinctive matches (no false fire)', () => {
    const hit = selectHintMatchedSignal(MAISON_SALE_BUCKETS, ['checkout', 'latency']);
    expect(hit).toBeNull();
  });

  it('returns null when the hint has no distinctive tokens', () => {
    expect(selectHintMatchedSignal(MAISON_SALE_BUCKETS, ['the', 'not', 'found'])).toBeNull();
  });

  it('ignores singleton/low-volume noise (count < 2)', () => {
    const buckets: SignalLike[] = [{ key: 'SALE_028', count: 1, message: 'Sale with link not found' }];
    expect(selectHintMatchedSignal(buckets, ['sale', 'links'])).toBeNull();
  });
});
