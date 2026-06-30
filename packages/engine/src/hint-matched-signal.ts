/**
 * HOR-453 — pick the strongest SYMPTOM-matched runtime signal the seed↔error-join
 * couldn't link. Pure + deterministic so the precision gate is unit-tested against
 * real maison buckets (no live ES needed).
 *
 * Context: when no error is structurally linked to the seed, the dominant signal that
 * literally names the symptom is often WARN-level (e.g. SALE_028 "Sale with link not
 * found" for "sale links broken") and never becomes a candidate. A bounded, hint-text-
 * scoped warn fetch retrieves it — but that fetch also pulls loud unrelated "...not
 * found" warnings (WARN998 "Product not found", 28k×). The gate below keeps precision:
 * a signal qualifies only when its EVENT_CODE shares a DISTINCTIVE (non-generic) hint
 * token, OR its message shares >=2 distinctive tokens. That picks SALE_028 for a "sale"
 * hint and rejects WARN998 — and rejects the attempt-1 false match (PRS_PRD03 ~ generic
 * "product"), since generic e-commerce words are excluded from "distinctive".
 */

export interface SignalLike {
  key: string;
  count: number;
  message?: string | null;
}

export interface HintMatchedSignal {
  code: string;
  count: number;
  message: string;
  /** How the match was made (audit). */
  via: 'code' | 'message';
}

/**
 * Generic, near-vacuous tokens in an e-commerce/incident domain. Matching on these
 * narrates an unrelated loud signal onto the seed, so they never count as "distinctive".
 */
const GENERIC_MATCH_STOP = new Set([
  'product', 'products', 'order', 'orders', 'sync', 'syncing', 'synced', 'fetch', 'fetching',
  'api', 'data', 'service', 'services', 'update', 'updating', 'request', 'requests', 'response',
  'error', 'errors', 'get', 'getting', 'save', 'saving', 'load', 'loading', 'create', 'creating',
  'delete', 'failing', 'failed', 'failure', 'broken', 'value', 'values', 'record', 'records',
  'found', 'not', 'with', 'the', 'and', 'for', 'from', 'into', 'this', 'that', 'when', 'returns',
  'returning', 'stale', 'wrong', 'issue', 'issues', 'problem', 'slow', 'down', 'production',
]);

/** Distinctive (>=4 chars, non-generic) hint tokens — the only ones that can match. */
export function distinctiveHintTokens(meaningfulHintTokens: readonly string[]): string[] {
  return [...new Set(meaningfulHintTokens.map((t) => t.toLowerCase()))].filter(
    (t) => t.length >= 4 && !GENERIC_MATCH_STOP.has(t),
  );
}

/** event_code alpha segments of >=4 chars, lowercased (digits/separators dropped). */
function codeSegments(code: string): string[] {
  return code
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((s) => s.length >= 4);
}

/**
 * Of `signals`, return the best symptom-matched one for the hint, or null. Precision-gated:
 * event_code shares a distinctive token, OR the message shares >=2 distinctive tokens; and
 * count >= 2. Ranked by match quality (code match first) then volume. Pure.
 */
export function selectHintMatchedSignal(
  signals: readonly SignalLike[],
  meaningfulHintTokens: readonly string[],
): HintMatchedSignal | null {
  const distinctive = distinctiveHintTokens(meaningfulHintTokens);
  if (distinctive.length === 0) return null;

  let best: (HintMatchedSignal & { score: number }) | null = null;
  for (const s of signals) {
    if (!s.key || s.key === '(none)' || s.count < 2) continue;
    const codeHit = codeSegments(s.key).some((seg) => distinctive.includes(seg));
    const msg = (s.message ?? '').toLowerCase();
    const msgHits = distinctive.filter((t) => msg.includes(t)).length;
    if (!codeHit && msgHits < 2) continue;
    // Code match is the strongest signal; otherwise rank by how many distinctive tokens hit.
    const score = (codeHit ? 1000 : 0) + msgHits * 10 + Math.min(9, Math.log10(Math.max(1, s.count)));
    if (best === null || score > best.score) {
      best = {
        code: s.key,
        count: s.count,
        message: s.message ?? '',
        via: codeHit ? 'code' : 'message',
        score,
      };
    }
  }
  if (best === null) return null;
  const { score: _score, ...result } = best;
  void _score;
  return result;
}
