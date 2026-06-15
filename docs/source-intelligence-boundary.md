# Horus source-intelligence boundary (HOR-50)

> This document is the safety pass for HOR-42 (progressive Axon internalization).
> It audits the primary Axon/axoniq surface categories in both the Horus monorepo and the
> Mhmdhammoud/axon fork, and classifies each surface so future agents know what
> is safe to rename and what must stay compatible.
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
Horus source-intelligence boundary   ←── this document
         │
         ├─ packages/connectors/src/axon/         ← Axon-specific adapters
         │      client.ts       HTTP transport (AxonHttpClient)
         │      provider.ts     CodeProvider impl (AxonCodeProvider)
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
               stitch.ts imports AxonHttpClient directly  ← MIGRATION DEBT (see §2g)
               (bypasses CodeProvider interface — concrete coupling)

packages/engine/                 ← investigation engine; takes CodeProvider interface;
                                    no direct Axon import, uses the connector boundary.
```

---

## Part 1 — Fork-side audit (Mhmdhammoud/axon)

The fork lives at `https://github.com/Mhmdhammoud/axon`.

**Audit metadata:**
* Fork HEAD: `99b6409a97e2ea940b4a77a52af9e9cb6020f363`
* Audit date: 2026-06-15
* PyPI package: `axoniq` v1.0.1
* Python package namespace: `axon` (all source under `src/axon/`)
* CLI binary entry point: `axon = "axon.cli.main:app"` (`pyproject.toml [project.scripts]`)
* Storage prefix: `.axon/` (per-repo) and `~/.axon/` (global registry)
* MCP resource URIs defined: `axon://overview`, `axon://dead-code`, `axon://schema`

The fork is classified using the same five-bucket scheme as the Horus-side audit below.

### Fork Bucket F1 — Presentation text (safe to change in a Horus-owned fork)

These strings appear in product output but carry no protocol meaning. A Horus-owned
fork may change them freely.

| File (in fork) | Line | Current text |
|---|---|---|
| `src/axon/__init__.py` | 1 | `"""Axon — Graph-powered code intelligence engine."""` (module docstring) |
| `src/axon/cli/main.py` | 1 | `"""Axon CLI — Graph-powered code intelligence engine."""` (module docstring) |
| `src/axon/cli/main.py` | 141 | `f"[yellow]Update available:[/yellow] Axon {latest} "` (update notification) |
| `src/axon/cli/main.py` | 396 | `help="Axon — Graph-powered code intelligence engine."` (CLI description) |
| `src/axon/cli/main.py` | 402 | `console.print(f"Axon v{__version__}")` (version banner) |
| `src/axon/cli/main.py` | 417 | `"""Axon — Graph-powered code intelligence engine."""` (root command docstring) |
| `src/axon/cli/main.py` | 529 | `console.print(f"[bold green]Axon UI[/bold green] running at {host_url}")` |
| `src/axon/cli/main.py` | 956 | `help="Force standalone UI mode even if a shared Axon host is already running."` |
| `src/axon/cli/main.py` | 959 | `"""Launch the Axon web UI."""` (command docstring) |
| `src/axon/cli/main.py` | 966 | `f"[bold green]Axon UI[/bold green] available at {live_host['host_url']}"` |
| `src/axon/cli/main.py` | 974 | `f"[bold green]Axon UI[/bold green] running at http://{DEFAULT_HOST}:{port}"` |
| `src/axon/cli/main.py` | 992 | `already_running_message="[bold green]Axon UI[/bold green] available at {url}"` |
| `src/axon/cli/main.py` | 1017 | `console.print(f"[bold green]Axon UI[/bold green] running at http://localhost:{port}")` |
| `src/axon/mcp/resources.py` | 26 | `"Axon Codebase Overview"` (MCP resource header) |
| `src/axon/mcp/resources.py` | 131 | `"""Axon Knowledge Graph Schema` (schema description) |
| `src/axon/web/app.py` | 1 | `"""FastAPI application factory for the Axon Web UI."""` (module docstring) |
| `src/axon/web/app.py` | 99 | `title="Axon Web UI"` (FastAPI app title) |
| `src/axon/web/app.py` | 146 | `title="Axon UI Proxy", description="UI proxy for a shared Axon backend"` |

### Fork Bucket F2 — Frozen from Horus perspective (must stay compatible)

These are the surfaces Horus **actually depends on**, plus fork-internal identifiers that have no current Horus consumer. Horus cannot unilaterally change the dependency surfaces.

| Surface | Detail | Blocker / Note |
|---|---|---|
| **PyPI package name** `axoniq` | `pyproject.toml: name = "axoniq"`. Horus `setup.ts` runs `uv tool install axoniq==…`. | Cannot change until Horus publishes its own PyPI package under a new name and updates `setup.ts`. |
| **CLI binary name** `axon` | `[project.scripts] axon = "axon.cli.main:app"`. Horus lifecycle shells out to `axon analyze .` and `axon host --port N`. | **Frozen**: any rename requires coordinating `packages/connectors/src/axon/lifecycle.ts` and `packages/cli/src/commands/stop.ts` (regex pattern). |
| **Storage paths** `.axon/` | `.axon/host.json`, `.axon/kuzu`, `.axon/host-leases` (per repo); `~/.axon/repos/` (global). | `packages/cli/src/commands/stop.ts` reads `.axon/host.json` via `readAxonHostUrl()`. **Frozen** until Horus adopts a migration shim. |
| **HTTP API routes** | 19+ call sites in Horus. Full route list in `docs/axon-compat.md §1`. | **Frozen**: see compat doc. |
| **Cypher / Kùzu graph schema** | Node labels, relationship types in `docs/axon-compat.md §2`. | **Frozen**: hand-written Cypher in Horus breaks silently on any label/property rename. |
| **Python import namespace** `axon` | All `from axon.xxx import yyy` imports in `src/axon/`. | Fork-internal; **no current Horus consumer**. Horus never imports Python. Renaming is self-contained to the fork plus a pin bump in Horus `setup.ts`. |
| **MCP resource URIs** `axon://` | `axon://overview`, `axon://dead-code`, `axon://schema` (`src/axon/mcp/server.py:459–483`). | Fork-internal; **no current Horus consumer**. Horus uses HTTP routes, not MCP resources. May affect external MCP clients if renamed. |
| **Update check URL** | `UPDATE_CHECK_URL = "https://pypi.org/pypi/axoniq/json"` (`cli/main.py:50`). | Fork-internal; **no Horus dependency**. Relevant only if Horus ships its own fork-side update checker. |

### Fork Bucket F3 — Attribution/history (upstream identity and licensing provenance)

**Compliance gap — no LICENSE file present.** Neither `LICENSE`, `LICENSE.md`, nor `COPYING`
exists at fork HEAD `99b6409a...`. `README.md` contains a license badge linking to
`https://github.com/harshkedia177/axon/blob/main/LICENSE` (upstream MIT), but a remote link
does not preserve the license text in this fork. Before any redistribution under a
Horus-owned fork, the upstream MIT copyright notice and permission text must be added as a
`LICENSE` file in the fork root.

| File | Attribution surface | Note |
|---|---|---|
| `README.md` | Upstream product identity (`harshkedia177/axon`), GitHub URL, PyPI/download badges, license badge linking to upstream `LICENSE`. | Upstream attribution reference — preserve or clearly acknowledge upstream origin. The badge link alone does not satisfy the MIT obligation to include the license text; see compliance gap above. |
| `pyproject.toml` — `authors` + `license` | `authors = [{name = "harshkedia177", email = "harshkedia717@gmail.com"}]`; `license = "MIT"`. | Provenance metadata. MIT's legal obligation is to preserve the upstream copyright notice and permission text (in a `LICENSE` file), **not** to retain package author metadata verbatim. The `authors` field may be updated in a Horus fork; the copyright notice must be preserved. |

No `CHANGELOG`, `CHANGES`, or `HISTORY` file found at fork HEAD `99b6409a...`.

`CONTRIBUTING.md` is an upstream workflow guide — it is **not** an attribution or license artifact and may be replaced when the fork adopts Horus-specific contribution guidelines.

### Fork Bucket F4 — Dead/unused in fork

No dead or unreachable Axon-branded code identified at HEAD `99b6409a...`.

### Fork Bucket F5 — Fork tests/fixtures

The fork's `tests/` directory tests the fork's own behavior. Horus does not import or run these.

| Directory | Contents |
|---|---|
| `tests/cli/` | CLI command tests (including `test_main.py`) |
| `tests/core/` | Core library tests |
| `tests/e2e/` | End-to-end pipeline tests (`test_full_pipeline.py`) |
| `tests/mcp/` | MCP server tests |
| `tests/web/` | Web UI tests |

Horus contract tests are in `packages/connectors/src/axon/*.contract.test.ts`, not here.

---

## Part 2 — Horus-side audit

This section inventories the primary `Axon`/`axon`/`axoniq` surface categories in the Horus monorepo,
classified by the same five-bucket scheme.

Inventory command (reproducible):

```bash
rg -n -i '\baxon\b|axoniq' --type ts --type js --type sh --type md \
  --glob '!node_modules' --glob '!dist' --glob '!*.lock' .
```

### Bucket 1 — User-facing text safe to rename

These strings appear in terminal output. No test asserts on the exact wording.
Safe to change when HOR-63 is worked.

#### packages/cli/src/index.ts

| Line(s) | Current text | Context |
|---|---|---|
| 59 | `--axon <url>` option description on `connect` | CLI option label for the `connect` command |
| 122 | `'Stop the Axon host for the current repo (or --all to stop every host)'` | `stop` command description |
| 123 | `'stop all registered Axon hosts'` | `--all` option on `stop` |
| 130 | `'List registered Axon hosts and their live status (port, repo, running/stopped)'` | `hosts` command description |
| 160 | `'repository name to scope the Axon lookup to'` | `--repo` option on a command |
| 178 | `'Build the queue map for a project (run the stitcher against its Axon host)'` | `queues` command description |
| 245 | `'…which flows are affected (Axon change-impact)'` | `what-changed` command description |
| 346 | `'List configured repositories and their Axon host health'` | `status` command description (partial) |

#### packages/cli/src/commands/stop.ts

| Line(s) | Current text | Context |
|---|---|---|
| 47 | `'No Axon host found for this repo (.axon/host.json absent).'` | user message |
| 157 | `` `${pc.green('✓')} Stopped Axon host ` `` | success message |
| 202 | `'No running Axon hosts found.'` | user message (--all path) |

#### packages/cli/src/commands/index-repo.ts

| Line(s) | Current text | Context |
|---|---|---|
| 130 | `` `Reusing Axon host for ${label} at ${hostUrl}` `` | dim status message |
| 136 | `` `\`axon\` not found on PATH. Install it (see \`horus setup\`) and retry.` `` | error (also mentions binary name — see Bucket 2) |
| 140 | `'analyzing with Axon (first time — this can take a while)…'` | dim status message |
| 144 | `` `axon analyze failed: ${err.message}` `` | error message |
| 148 | `'already analyzed (.axon present)'` | dim message |
| 152 | `` `starting Axon host on port ${port}…` `` | dim status message |
| 159 | `` `Axon host did not become healthy — see ${root}/.horus/axon-host.log` `` | error message |

#### packages/cli/src/commands/architecture.ts, blast-radius.ts, changes.ts, explain.ts, onboard.ts, simulate.ts

| Pattern | Text | Context |
|---|---|---|
| all 6 files | `'Axon host unreachable — start it with: axon host --port 8420'` | error message (also mentions binary name — see Bucket 2) |

#### packages/cli/src/commands/investigate.ts

| Pattern | Text | Context |
|---|---|---|
| error | `'Axon host unreachable for …'` | error message |

#### packages/cli/src/commands/hosts.ts

| Line | Text | Context |
|---|---|---|
| dim | `'No Axon hosts found. Run \`horus index\` to start one.'` | user message |

#### packages/cli/src/commands/status.ts

| Line | Text | Context |
|---|---|---|
| label | `'Axon'` (bold label in status output) | Suggested: `'Source'` or `'Code index'` |
| dim | `'pinned Axon: … transport: HTTP/MCP only'` | status line |

#### packages/cli/src/commands/init.ts

| Line | Text | Context |
|---|---|---|
| dim | `'no Axon host set — run \`horus index\`…'` | user message |

#### packages/connectors/src/factory.ts

| Line | Text | Context |
|---|---|---|
| ~150 | `` `No Axon connector configured for project "${renv.project}" / env "${renv.env}".` `` | thrown error (provider error output) |

**When to rename Bucket 1:** when HOR-63 (safe Horus branding) is worked. Change leaf
strings in one PR; no tests assert on exact wording.

**`docs/install.md` — stale user-facing documentation (update/remove):** The real installer
is live at `https://horus.sh/install.sh`. This file describes the old preview bootstrap
workflow referencing Axon setup steps and is now stale. It should be updated to reference
the live installer URL or removed. It is no longer a leave-as-is attribution document.

---

### Bucket 2 — Internal compatibility surfaces (must stay until Axon is internalized)

#### 2a. Config key `axon.hostUrl` (core/config.ts)

```ts
axon: z.object({ hostUrl: z.string().url() }).optional(),
```

All existing `horus.config.ts` files and user configs use this key.
`README.md` example configs reference it. **Frozen** until a migration shim or
config-version bump is in place.

#### 2b. `axonHostUrl` resolved field (core/config.ts, all CLI commands)

`ResolvedRepository` carries `axonHostUrl?: string`. Every code-intelligence
CLI command reads `renv.repositories[0]?.axonHostUrl`. **Frozen** — read by every
command that touches source context.

#### 2c. `--axon <url>` option on `horus connect` (cli/src/index.ts:59)

```ts
.option('--axon <url>', 'Axon host URL for this repo')
```

The option key `axon` maps to `opts.axon` in the connect handler. The `axon.hostUrl`
config key is written from this value. **Frozen** as a config interface surface until
the config schema is migrated.

#### 2d. PyPI package name `axoniq` (cli/src/commands/setup.ts)

```ts
`uv tool install axoniq==${PINNED_AXON_VERSION}`
```

Third-party PyPI name. **Cannot be renamed** in Horus without a matching PyPI
publication under a new name.

#### 2e. Class names in `packages/connectors/src/axon/`

| Symbol | Where used | Blocker |
|---|---|---|
| `AxonHttpClient` | factory, lifecycle, stitcher, CLI commands | Transport adapter; rename with provider |
| `AxonCodeProvider` | factory | `CodeProvider` impl; rename when rebrand is done |
| `AxonHttpError` | client internals | Low-risk; internal only |
| `AxonCompatibility` | compat.ts | Compatibility result type |
| `AxonHealth`, `AxonHostInfo`, `AxonOverview`, `AxonSearchResult`, `AxonCypherResult`, `AxonDiffResult`, `AxonImpactResult` | client wire types | Wire-shape aliases; rename freely once HTTP contract is stable |

**Safe rename order for HOR-64:** wire-type aliases first (lowest blast radius),
then `AxonCodeProvider` + `AxonHttpClient` together, then `AxonHttpError`,
then `AxonCompatibility`. The `CodeProvider` interface (`contract.ts`) is already
Horus-owned and does not mention Axon.

#### 2f. Lifecycle CLI commands (connectors/src/axon/lifecycle.ts, commands/stop.ts)

```ts
// lifecycle.ts
spawn('axon', ['analyze', '.'])
spawn('axon', ['host', '--port', String(port)])
spawn('axon', ['--version'])

// stop.ts:123
`(?:^|\\s)(?:\\S*/)?axon\\s+host\\s+--port(?:=|\\s+)${portStr}(?=\\s|$)`
```

These shell out to the `axon` binary and pattern-match its process args. **Frozen**
until the binary is renamed on the fork side (Fork Bucket F2).

#### 2g. Stitcher direct `AxonHttpClient` import — CONCRETE COUPLING DEBT

```ts
// packages/stitcher/src/stitch.ts:6
import { AxonHttpClient } from '@horus/connectors';

// stitch.ts function signature
export async function stitch(client: AxonHttpClient, db: HorusDb, ...): ...
```

The stitcher receives an `AxonHttpClient` instance directly, bypassing the
`CodeProvider` interface. This means the stitcher is coupled to the concrete Axon
transport, not to the abstraction.

**Classification: Bucket 2 — migration debt.** The `CodeProvider` interface in
`packages/connectors/src/contract.ts` does not include the raw Cypher operations the
stitcher needs. The migration prerequisite is:

1. Extend `CodeProvider` (or add a narrower `CypherProvider` sub-interface) with the
   Cypher operations used by `stitch.ts` and `extract.ts`.
2. Update stitcher to accept the interface, not the concrete class.
3. This change is prerequisite to renaming `AxonHttpClient`.

Until step 1 is done, the stitcher is **legitimately coupled** to `AxonHttpClient`
and must remain so. Do not rename `AxonHttpClient` without first completing the
interface extraction.

#### 2h. `PINNED_AXON_VERSION` and `getAxonVersion` (core/version.ts)

Used by `horus setup` to verify the installed backend version. Rename to
`PINNED_SOURCE_VERSION` / `getSourceBackendVersion` when the binary name changes.

#### 2i. `.axon/host.json` on-disk file

Read by `readAxonHostUrl()` to detect a live host per-repo. **Frozen** — matches the
fork's storage path (Fork Bucket F2).

---

### Bucket 3 — Documentation/attribution references (leave as-is)

These name Axon as the upstream tool, not as a Horus product identity.

| File | Why it stays |
|---|---|
| `docs/axon-compat.md` | Compatibility contract against the Axon fork. Authoritative for what must not change in the fork. |
| `docs/axon-round-2.md` | Capability probe research log. Historical record — append updates only. |
| `docs/architecture.md` | Architecture decisions referencing Axon as the current backend. Update when backend ships. |
| `docs/risk-analysis.md` | Risk register referencing Axon version risk. Update when risk resolves. |
| `README.md` | User-facing documentation describing Axon as the default source-intelligence backend. Update when backend ships under new name. Includes config examples (`axon: { hostUrl: … }`) — these reflect the frozen config key (Bucket 2a). |
| `config/horus.config.ts` | Example config with `axon: { hostUrl: … }` and `axon: { pinnedVersion: … }` entries. Reflects frozen config keys. |
| `packages/connectors/src/contract.ts` comments | `"backed by Axon"` in doc comments. Attribution. |
| `packages/connectors/src/factory.ts` comments | Multiple `// Axon belongs to…` and error strings describing the connector type. Comments describing frozen architecture. |
| `packages/connectors/src/git/provider.ts` comments | `"to Axon queries"` attribution comment. |
| `packages/stitcher/src/index.ts` comments | `"Axon's static flow graph"` description. |
| `packages/stitcher/src/stitch.ts` comments | `"pull … nodes from Axon over Cypher"`. |

---

### Bucket 4 — Dead/unused

No dead Axon code identified. The two zero-call-site client methods (`hostInfo()`,
`overview()`) are retained for headroom (see `docs/axon-compat.md §FREE`).

---

### Bucket 5 — Contract tests (must pass on version bump)

| File | What it guards | Update trigger |
|---|---|---|
| `packages/connectors/src/axon/contract.test.ts` | HTTP API contract (all 6 routes) | Axon HTTP route/shape change |
| `packages/connectors/src/axon/provider.contract.test.ts` | `AxonCodeProvider` behavior | Provider logic change |
| `packages/connectors/src/axon/schema.contract.test.ts` | Cypher node labels + rel_type values | Graph schema change |

Run before any `PINNED_AXON_VERSION` bump:
```bash
pnpm --filter @horus/connectors test
```

---

## Frozen surfaces (summary)

Must not change without a migration plan:

1. **`axon.hostUrl` config key** — breaks existing user configs and CLI option mapping.
2. **`axonHostUrl` resolved field** — read by every code-intelligence CLI command.
3. **HTTP routes** (see `axon-compat.md §1`) — 19+ call sites.
4. **Cypher / Kùzu graph schema** (see `axon-compat.md §2`) — hand-written queries; silently breaks on rename.
5. **`axon analyze` / `axon host --port N`** lifecycle commands — only shell-out surface.
6. **`.axon/host.json` on-disk file** — read by `readAxonHostUrl()` to detect a live host.
7. **`axoniq` PyPI name** — Horus `setup.ts` install target; cannot change without a new PyPI publication.
8. **Contract tests** — must pass against any pinned version.
9. **Stitcher `AxonHttpClient` type** — blocked on `CodeProvider`/`CypherProvider` interface extraction (§2g).

Note: `axon://` MCP resource URIs are **not** a Horus frozen surface. Horus has no consumers of these URIs (Horus uses HTTP routes, not MCP resources). They are fork-internal (Fork Bucket F2, no current Horus consumer) and may affect external MCP clients if renamed, but do not constrain Horus internalization.

---

## Safe rebrand surfaces (summary)

In recommended order:

1. **Bucket 1 user-facing strings** — any time; no test asserts on wording.
2. **Wire-type aliases** (`AxonCypherResult`, `AxonDiffResult`, …) — rename with search-replace; no external contract.
3. **`AxonCodeProvider` + `AxonHttpClient`** — rename together after wire types done AND after stitcher interface extraction (§2g).
4. **`AxonCompatibility` + `checkAxonCompatibility`** — rename after CLI status uses new names.
5. **`PINNED_AXON_VERSION` / `getAxonVersion`** — rename when binary name changes.
6. **`axon.hostUrl` config key** — last; needs migration shim or config-version bump.

---

## For future agents (HOR-42 continuation)

Before touching any Axon reference:

1. Check this document's bucket classification.
2. If Bucket 1 (user text): rename freely, no test impact.
3. If Bucket 2 (compat): check the entry's explicit blocker. Do not rename without it.
4. If Bucket 3 (attribution): do not rename — append a note if facts change.
5. If Bucket 5 (contract tests): run them against the new version before merging.
6. Any code rename touching `axon.hostUrl`, graph schema, or HTTP routes requires coordinated change with `docs/axon-compat.md` and the Axon fork. MCP resource URIs (`axon://`) are fork-internal (Fork Bucket F2, no current Horus consumer) and not a Horus contract — they can be renamed in the fork without Horus changes, but external MCP clients may be affected.
7. The stitcher's `AxonHttpClient` dependency (§2g) is migration debt, not an error — do not remove it until the `CypherProvider` interface exists.
