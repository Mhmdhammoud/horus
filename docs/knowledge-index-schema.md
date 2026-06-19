# Local project-knowledge index — schema & store (HOR-291)

The first-version contract for the Horus CLI's **local project-knowledge index**,
implemented in `@horus/knowledge` (`packages/knowledge`). It defines what
`horus index` produces, what `horus knowledge` and Horus MCP query, and the shape
optional cloud sync ships. **Local-first: nothing here requires Horus Cloud.**

## The three knowledge layers (boundary)

Horus keeps three distinct layers. This index is only the middle one.

| Layer | Question it answers | Owner / engine | Storage | Lifetime |
|---|---|---|---|---|
| **Source intelligence** | "What symbols/files/calls exist?" | Axon (`horus-source`, Kùzu graph) | `.horus/source/` + HTTP host | Rebuilt from code |
| **Project knowledge** (this) | "How does this project *work*?" — operations, types, domain concepts, flows | Horus CLI (`horus index`) | `.horus/index/` (JSON) | Snapshot per index run |
| **Runtime evidence** | "What happened in this incident?" | Investigation engine | CLI local Postgres (`evidence`, `findings`, …) | Per-investigation |

Rules that keep the layers clean:

- Project knowledge **references** Axon (file path, line range, symbol) via each
  item's `provenance`; it never copies the code graph. Deep structural queries
  defer to Axon over HTTP.
- Project knowledge holds **durable project facts**, not incident observations.
  Time-stamped, per-incident data stays in the Postgres runtime-evidence tables.
- Source intelligence and runtime evidence are inputs; project knowledge is the
  curated, queryable distillation agents read first.

## Storage layout

Under the repo's existing `.horus/` directory (alongside `source/`, `config.json`):

```
.horus/index/
  manifest.json         # index entrypoint: schema version, repos + HEAD shas, counts, file list, generator, Axon link
  knowledge-base.json   # CANONICAL full KnowledgeSnapshot (source of truth)
  contracts.json        # derived view: operations + types + enums + authRules
  domain-concepts.json  # derived view: domainConcepts
  data-flows.json       # derived view: dataFlows
  runtime-map.json      # derived view: runtimeComponents + externalIntegrations
  source-index.json     # optional: pointer/summary into Axon source intelligence
  index.db              # OPTIONAL (v2): SQLite for fast/semantic lookup — not written in v1
```

`knowledge-base.json` is authoritative; the split files are human-readable,
git-diffable projections for debugging and partial reads. `manifest.json` is cheap
to read and tells a tool what exists and how fresh it is without parsing the full
snapshot. `.horus/` is already git-ignored by `horus index`.

## Schema (`@horus/knowledge`)

`KnowledgeSnapshot` is a versioned container of categorized items. Every item
carries a **stable id**, optional **scope** (project/repository), and
**provenance**. Categories (each an array):

- `repositories` — `RepositoryProfile`: repo role, frameworks, languages, data sources, integrations (the project landscape).
- `operations` — `Operation`: protocol-agnostic API contracts (GraphQL first; REST/RPC representable) with `kind`, `args`, `returnType`, `auth`.
- `types` — `TypeDefinition`: input/response/object/scalar/interface/union, with `fields`.
- `enums` — `EnumDefinition`.
- `authRules` — `AuthRule`: who may invoke what.
- `domainConcepts` — `DomainConcept`: cross-cutting concepts linking operations + types.
- `frontendPatterns` — `FrontendPattern`: hooks/stores/providers/server-functions/components.
- `dataFlows` — `DataFlow`: ordered paths data takes across components.
- `runtimeComponents` — `RuntimeComponent`: services/workers/cron/queues.
- `externalIntegrations` — `ExternalIntegration`: third-party systems.

These map directly onto the Maison Safqa MCP prototype
(`operations`/`inputTypes`/`responseTypes`/`enums`/`frontendPatterns`/`domainConcepts`/`projectProfiles`),
which is why HOR-292's import adapter can target this schema 1:1 (a test in
`schema.test.ts` exercises the prototype shapes).

### Provenance (`ProvenanceSchema`)

Captured "where available" — only `sourceType` is required:

| Field | Meaning |
|---|---|
| `sourceType` | `parsed` \| `inferred` \| `manual` \| `runtime` \| `agent-confirmed` |
| `confidence` | `high` \| `medium` \| `low` |
| `repo`, `filePath`, `lineRange` | where the fact lives |
| `gitSha` | commit it was generated from |
| `generatedAt`, `lastSeen` | when produced / last confirmed present |
| `contentHash` | hash of the source span — the staleness anchor |

### Staleness model

`itemStatus(provenance, { contentHash, headSha })` returns `current | stale | unknown`:

- A **parsed** (or **runtime**) item with a `contentHash` is **stale** when the
  current source hash differs, **current** when it matches.
- **manual / inferred / agent-confirmed** items are not 1:1 with a file hash, so
  they're reported `unknown` rather than falsely flagged.
- With nothing to compare, the status is `unknown`.

The manifest records each repo's indexed `headSha`, so a tool can detect "the repo
moved on" cheaply and trigger a re-index; per-item `contentHash` localizes which
items actually went stale.

## Design-question decisions (v1)

- **Canonical store = JSON files.** Human-readable, git-diffable, zero native
  deps, trivially queryable by load-and-filter. Matches the prototype.
- **SQLite (`index.db`) is deferred to v2** — an optional acceleration/embedding
  layer behind the same `KnowledgeStore` interface; v1 callers don't change when
  it lands.
- **Queryable without embeddings:** everything is reachable by id, name, category,
  repo, and domain via plain in-memory filtering. Semantic search is an optional
  later layer, never a requirement.
- **Human-readable for debugging:** all v1 artifacts are pretty-printed JSON.
- **Relation to Axon:** items cite Axon locations via provenance but never
  duplicate the graph; `source-index.json` may hold a lightweight pointer/summary.

## What follow-ups build against this

- **HOR-292** — import Maison Safqa `knowledge-base.json` → `KnowledgeSnapshot` via `createJsonKnowledgeStore(root).write(...)`.
- **HOR-293** — `horus index` populates the snapshot from source + Axon.
- **HOR-294** — `horus knowledge` queries the snapshot (`readSnapshot()` + filters).
- **HOR-295** — Horus MCP exposes the snapshot to agents.
- **HOR-296** — optional cloud sync ships the snapshot + manifest.

API surface: `import { KnowledgeSnapshotSchema, KnowledgeManifestSchema, createJsonKnowledgeStore, knowledgePath, itemStatus } from '@horus/knowledge'`.
