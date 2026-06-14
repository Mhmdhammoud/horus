# Evidence Model — Migration Notes (HOR-13)

## What changed

Two optional fields were added to the `Evidence` interface in `@horus/core`:

```ts
priority?: EvidencePriority;  // 'critical' | 'high' | 'medium' | 'low' | 'info'
category?: EvidenceCategory;  // 'queue' | 'database' | 'cache' | 'logs' | 'code' | 'deployment' | 'metrics' | 'other'
```

`priority` is an investigation-triage tier — it reflects how much attention
an evidence item deserves during an investigation, **not** operational severity
or production impact. It is derived from evidence `kind` and `relevance` by the
normalization layer.

`category` is a broad functional bucket for grouping. `'cache'` was added to
cover Redis / Memcached evidence (`kind: 'redis-key'`), which shares
`source: 'state'` with MongoDB but must not be grouped under `'database'`.

All existing code compiles unchanged — the fields are optional and providers
do not set them. The normalization layer (`normalizeEvidence()` in
`@horus/engine`) fills them in at investigation time.

## Backward compatibility

- **Providers**: no changes required. `toEvidence()` and `queueStateToEvidence()`
  return the same shape they always did; `priority` and `category` will be
  `undefined` until `normalizeEvidence()` runs.
- **Renderers**: `render.ts` and `reportToMarkdown` are unchanged. The new
  fields are available for future use but are not read today.
- **Persisted reports**: existing database rows do not have `priority`/`category`;
  they remain valid — fields are optional.

## Consumer guide

If you read `Evidence` objects and want to use `priority` or `category`, ensure
you call `normalizeEvidence()` first:

```ts
import { normalizeEvidence } from '@horus/engine';

const evs: Evidence[] = await provider.toEvidence(state);
normalizeEvidence(evs);

for (const e of evs) {
  console.log(e.priority, e.category);  // filled in
}
```

`normalizeEvidence()` is idempotent, so calling it multiple times is safe.

`priority` is not a claim about operational impact. If your consumer needs true
production severity, derive it from the typed `payload` using the provider-
specific shape documented in `docs/evidence-model.md`.

## Adding a new EvidenceCategory

1. Add the new literal to `EvidenceCategory` in `packages/core/src/evidence.ts`.
2. Add a `case` (or kind-guard) to `categoryFor()` in `packages/engine/src/normalize.ts`.
3. Add tests in `packages/engine/src/normalize.test.ts`.
4. Update the table in `docs/evidence-model.md`.
