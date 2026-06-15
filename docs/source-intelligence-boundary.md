# Horus source-intelligence boundary (HOR-50)

> This document is the safety pass for HOR-42 (progressive Axon internalization).
> It audits every Axon/axoniq reference in the Horus codebase and classifies each
> one so future agents know what is safe to rename and what must stay compatible.
>
> Companion documents:
> * `docs/axon-compat.md` — frozen HTTP + Cypher + CLI contract on the Axon fork side.
> * `docs/axon-round-2.md` — capability probe and upgrade notes.

---

## Architecture layer diagram

```
horus CLI (packages/cli)
   └─ commands: investigate, index, status, hosts, stop, …
         │
         ▼
Horus source-intelligence boundary   ←── this boundary
         │
         ├─ packages/connectors/src/axon/         ← Axon-specific adapters
         │      client.ts       HTTP transport
         │      provider.ts     CodeProvider impl
         │      lifecycle.ts    shell-out: axon analyze / host
         │      types.ts        Axon wire shapes
         │
         ├─ packages/connectors/src/compat.ts      ← version/schema check
         ├─ packages/connectors/src/factory.ts     ← wires client + provider
         │
         ├─ packages/core/src/config.ts            ← axon.hostUrl config key
         ├─ packages/core/src/version.ts           ← PINNED_AXON_VERSION
         │
         └─ packages/stitcher/                     ← queue-bridge over Axon content
               (already Horus-owned; only imports AxonHttpClient)

packages/engine/                 ← investigation engine; takes CodeProvider interface;
                                    no direct Axon import, uses the connector boundary.
```

---

## Reference audit

### Bucket 1 — User-facing text that should become Horus over time

These are strings printed to the user's terminal that name "Axon" as a product.
They are safe to rename at any time (no test contract depends on the exact text).

| File | Line/pattern | Current text | Suggested future text |
|---|---|---|---|
| `packages/cli/src/commands/architecture.ts` | error message | `Axon host unreachable — start it with: axon host --port 8420` | `Source host unreachable — start it with: horus index` |
| `packages/cli/src/commands/blast-radius.ts` | error message | same | same |
| `packages/cli/src/commands/changes.ts` | error message | same | same |
| `packages/cli/src/commands/explain.ts` | error message | same | same |
| `packages/cli/src/commands/onboard.ts` | error message | same | same |
| `packages/cli/src/commands/simulate.ts` | error message | same | same |
| `packages/cli/src/commands/hosts.ts` | dim text | `No Axon hosts found. Run \`horus index\` to start one.` | `No source hosts running. Use \`horus index\` to start one.` |
| `packages/cli/src/commands/status.ts` | label | `Axon` (bold label in status output) | `Source` or `Code index` |
| `packages/cli/src/commands/status.ts` | dim line | `pinned Axon: ${PINNED_AXON_VERSION} · transport: HTTP/MCP only` | `source backend: ${PINNED_VERSION} · transport: HTTP/MCP` |
| `packages/cli/src/commands/init.ts` | dim text | `no Axon host set — run \`horus index\`…` | `no source host set — run \`horus index\`` |
| `packages/cli/src/commands/investigate.ts` | error message | `Axon host unreachable for …` | `Source host unreachable for …` |

**When to rename:** When HOR-63 (safe Horus branding) is worked. These are leaf
strings with no test assertions on the exact wording. Safe to change in one PR.

---

### Bucket 2 — Internal compatibility surfaces (must stay until Axon is internalized)

These are code symbols, config keys, and transport-level names that couple Horus to
the Axon-compatible binary. **Do not rename these without first shipping the
replacement.** Each entry notes the blocker.

#### 2a. Config key `axon.hostUrl` (core/config.ts)

```ts
// packages/core/src/config.ts
axon: z.object({ hostUrl: z.string().url() }).optional(),
```

All existing `horus.config.ts` files and user configs use this key. Renaming it
breaks existing installations. **Frozen** until a migration shim or a config-version
bump is in place.

#### 2b. `axonHostUrl` resolved field (core/config.ts)

The `ResolvedRepository` interface carries `axonHostUrl?: string`. All CLI commands
read `renv.repositories[0]?.axonHostUrl`. **Frozen** — every command that touches
code intelligence reads this field.

#### 2c. PyPI package name `axoniq` (packages/cli/src/commands/setup.ts)

```ts
`uv tool install axoniq==${PINNED_AXON_VERSION}`
```

`axoniq` is the published Python package name on PyPI. **This cannot be renamed** in
Horus — it is the public install name of the third-party tool. When Horus ships its
own fork under a different PyPI name, update `setup.ts` to use the new name and bump
`PINNED_AXON_VERSION` in `packages/core/src/version.ts`.

#### 2d. Class names in `packages/connectors/src/axon/`

| Symbol | Where used | Blocker |
|---|---|---|
| `AxonHttpClient` | factory, lifecycle, stitcher, CLI commands | Transport adapter; rename with provider |
| `AxonCodeProvider` | factory | CodeProvider impl; rename when rebrand is done |
| `AxonHttpError` | client internals | Error class; internal, low risk |
| `AxonCompatibility` | compat.ts | Compatibility check result type |
| `AxonHealth`, `AxonHostInfo`, `AxonOverview`, `AxonSearchResult`, `AxonCypherResult`, `AxonDiffResult`, `AxonImpactResult` | client wire types | Wire-shape aliases; rename freely once HTTP contract is stable |

**Safe rename order for HOR-64:** rename wire-type aliases first (lowest blast
radius), then `AxonCodeProvider` + `AxonHttpClient` together with a single-PR
search-replace, then `AxonHttpError`. The `CodeProvider` interface in
`contract.ts` is already Horus-owned — it does not mention Axon.

#### 2e. Lifecycle CLI commands (packages/connectors/src/axon/lifecycle.ts)

```ts
spawn('axon', ['analyze', '.'])
spawn('axon', ['host', '--port', String(port)])
spawn('axon', ['--version'])
```

These shell out to the `axon` binary on PATH. **These are the one place where
shell-outs are explicitly allowed** (see axon-compat.md §3). When the binary is
renamed, update these three call sites. The `horus stop` command (`stop.ts`) also
matches running processes by `axon host --port` pattern — update the regex there too.

#### 2f. `PINNED_AXON_VERSION` and `getAxonVersion` exports (core/version.ts, connectors/)

Used by `horus setup` to verify the installed backend matches the expected version.
Rename to `PINNED_SOURCE_VERSION` / `getSourceBackendVersion` when the binary name changes.

---

### Bucket 3 — Documentation/attribution references (leave as-is)

These are historical records and technical explanations. They name Axon as the
upstream tool, not as a Horus product identity. Do not alter them.

| File | Why it stays |
|---|---|
| `docs/axon-compat.md` | Compatibility contract against the Axon fork. Authoritative for what must not change in the fork. |
| `docs/axon-round-2.md` | Capability probe research log. Historical record — alter only to append updates. |
| `docs/architecture.md` | Architecture decisions that reference Axon as the current backend. Update when the backend ships. |
| `docs/risk-analysis.md` | Risk register referencing Axon version risk. Update when risk resolves. |

---

### Bucket 4 — Dead/unused (safe to remove, low priority)

No dead Axon code was identified in the current audit. The two "zero call-site"
endpoints in the Axon client (`hostInfo()`, `overview()`) are retained for headroom
(see axon-compat.md §FREE). They incur no runtime cost and may be useful for a
future `horus status --verbose`.

---

### Bucket 5 — Test fixtures requiring deliberate update

These tests are the contract guards for the Axon HTTP/Cypher surface. They must be
updated any time the Axon version pin changes.

| File | What it tests | Update trigger |
|---|---|---|
| `packages/connectors/src/axon/contract.test.ts` | HTTP API contract (all 6 routes) | Axon HTTP route/shape change |
| `packages/connectors/src/axon/provider.contract.test.ts` | `AxonCodeProvider` behavior | Provider logic change |
| `packages/connectors/src/axon/schema.contract.test.ts` | Cypher node labels + rel_type values | Graph schema change |

**These must pass against any new version of the Axon backend before bumping the
pin.** Run: `pnpm --filter @horus/connectors test`.

---

## Frozen surfaces (summary)

These must not change without a migration plan:

1. **`axon.hostUrl` config key** — breaks existing user configs.
2. **`axonHostUrl` resolved field** — read by every code-intelligence CLI command.
3. **HTTP routes** (see axon-compat.md §1) — Horus has 19+ call sites.
4. **Cypher / Kùzu graph schema** (see axon-compat.md §2) — hand-written queries; any property/label rename silently breaks investigation.
5. **`axon analyze` / `axon host --port N`** lifecycle commands — only safe shell-out surface.
6. **`.axon/host.json` on-disk file** — read by `readAxonHostUrl()` to detect a live host.
7. **Contract tests** — must continue to pass against any pinned version.

---

## Safe rebrand surfaces (summary)

Safe to rename without breaking Horus behavior, in recommended order:

1. **Bucket 1 user-facing strings** — any time; no test asserts on wording.
2. **`AxonCypherResult`, `AxonDiffResult`, … wire-type aliases** — rename with search-replace; no external contract.
3. **`AxonHttpClient` + `AxonCodeProvider`** — rename together in one PR after wire types are done; update all imports.
4. **`AxonCompatibility` + `checkAxonCompatibility`** — rename when CLI status uses new names.
5. **`PINNED_AXON_VERSION` / `getAxonVersion`** — rename when binary name changes.
6. **`axon.hostUrl` config key** — last; needs migration shim or config-version bump.

---

## What remains Axon (and why that is fine)

The packages below reference Axon because they are the compatibility layer:

```
packages/connectors/src/axon/     ← this IS the Axon adapter namespace
packages/connectors/src/compat.ts ← version check against Axon
packages/connectors/src/factory.ts ← wires Axon client + provider
```

All other Horus packages (`engine`, `db`, `ai`, `stitcher`) import only the
`CodeProvider` interface or `AxonHttpClient` for the queue-bridge — they are
already Horus-native. The engine never imports Axon directly; it takes a
`CodeProvider` from the factory. This boundary is the correct shape for
progressive internalization.

---

## For future agents (HOR-42 continuation)

Before touching any Axon reference:

1. Check this document's bucket classification.
2. If Bucket 1 (user text): rename freely, no test impact.
3. If Bucket 2 (compat): check the "Blocker" column; do not rename without the listed prerequisite.
4. If Bucket 3 (attribution): do not rename — add a note if facts change.
5. If Bucket 5 (contract tests): run them against the new version before merging.
6. Any code rename that touches `axon.hostUrl`, graph schema, or HTTP routes requires a coordinated change with `axon-compat.md` and the Axon fork.
