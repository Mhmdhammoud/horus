# Evidence Model — Migration Notes (HOR-13)

## What changed

Two optional fields were added to the `Evidence` interface in
`@horus/core`:

```ts
severity?: EvidenceSeverity;  // 'critical' | 'high' | 'medium' | 'low' | 'info'
category?: EvidenceCategory;  // 'queue' | 'database' | 'logs' | 'code' | 'deployment' | 'metrics' | 'other'
```

All existing code compiles unchanged — the fields are optional and providers
do not set them. The normalization layer (`normalizeEvidence()` in
`@horus/engine`) fills them in at investigation time.

## Backward compatibility

- **Providers**: no changes required. `toEvidence()` and `queueStateToEvidence()`
  return the same shape they always did; severity and category will be `undefined`
  until `normalizeEvidence()` runs.
- **Renderers**: `render.ts` and `reportToMarkdown` are unchanged. The new
  fields are available for future use but are not read today.
- **Persisted reports**: existing database rows do not have severity/category;
  they remain valid — fields are optional.

## Consumer guide

If you read `Evidence` objects and want to use severity or category, ensure
you call `normalizeEvidence()` first:

```ts
import { normalizeEvidence } from '@horus/engine';

const evs: Evidence[] = await provider.toEvidence(state);
normalizeEvidence(evs);

for (const e of evs) {
  console.log(e.severity, e.category);  // filled in
}
```

`normalizeEvidence()` is idempotent, so calling it multiple times is safe.

## Adding a new EvidenceCategory

1. Add the new literal to `EvidenceCategory` in `packages/core/src/evidence.ts`.
2. Add a `case` to `categoryFor()` in `packages/engine/src/normalize.ts`.
3. Add tests in `packages/engine/src/normalize.test.ts`.
4. Update the table in `docs/evidence-model.md`.
