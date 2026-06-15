# Source-intelligence naming decision table (HOR-81)

Based on `docs/axon-surface-inventory.md` (HOR-79).
Migration ordering and follow-up ticket candidates are in `docs/axon-migration-checklist.md` (HOR-80).

## How to read this table

| Status | Meaning |
|--------|---------|
| **FROZEN** | Must not change — external binary, upstream package, or user config compat |
| **ALIAS-READY** | Add Horus name now (additive); Axon name stays for one release |
| **DONE** | Horus alias already exported (no action needed) |
| **RENAME-LATER** | Rename after alias ships and prerequisite is resolved |
| **UPDATE** | Wording/docs change only — no API or config impact |

---

## CLI commands and flags

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `axon host --port N` | — | **FROZEN** | External binary; Horus cannot rename |
| `axon analyze .` | — | **FROZEN** | External binary; Horus cannot rename |
| `axon --version` | — | **FROZEN** | External binary; Horus cannot rename |
| `horus init --axon <url>` | `horus init --source-url <url>` | **ALIAS-READY** | Add `--source-url` alias; keep `--axon` for back-compat |

---

## Config keys and resolved fields

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `axon.hostUrl` (in `.horus/config.json`) | `source.hostUrl` | **FROZEN** | Breaking for existing configs; needs migration shim first (see `source-compat-checklist.md §Config key migration`) |
| `axonHostUrl` (resolved context field) | `sourceHostUrl` | **FROZEN** | Downstream of `axon.hostUrl`; rename only after config migration shim ships |
| `axon: { hostUrl }` in `config/horus.config.ts` template | — | **FROZEN** | Must match the schema; changes when config key renames |

---

## User-visible output terms

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `pinned backend: ${PINNED_AXON_VERSION}` | `pinned source-intelligence: ...` | **UPDATE** | String change only; no compat risk |
| `start it with: axon host --port 8420` | — | **FROZEN** | `axon` is the external binary the user must run |
| `` `axon` not found on PATH `` | — | **FROZEN** | Binary name check; cannot rename the binary |
| `.horus/axon-host.log` (log path in error) | `.horus/source-host.log` | **RENAME-LATER** | Coordinate with docs update; no compat gate needed beyond that |
| Doctor hint: `pass --axon <url> to horus init` | `pass --source-url <url>` | **UPDATE** | After `--source-url` alias (ALIAS-READY above) lands |
| `axoniq` (pip package name in setup output) | — | **FROZEN** | Upstream PyPI package; Horus has no control |

---

## Developer API — connectors package

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `AxonHttpClient` | `SourceHttpClient` | **ALIAS-READY** | Re-export from `packages/connectors/src/index.ts` |
| `AxonHttpError` | `SourceHttpError` | **ALIAS-READY** | Re-export alongside `AxonHttpError` |
| `AxonClientOptions` | `SourceClientOptions` | **ALIAS-READY** | Re-export alongside `AxonClientOptions` |
| `AxonCodeProvider` | `SourceCodeProvider` | **ALIAS-READY** | Re-export from provider; `AxonCodeProvider` stays |
| `axonAvailable()` | `sourceAvailable()` | **ALIAS-READY** | Re-export wrapper in lifecycle; keep `axonAvailable()` |
| `getAxonVersion()` | `getSourceVersion()` | **ALIAS-READY** | Re-export wrapper |
| `readAxonHostUrl()` | `readSourceHostUrl()` | **ALIAS-READY** | Re-export wrapper |
| `AxonCompatibility` | `SourceCompatibility` | **DONE** | Alias already exported (HOR-50) |
| `checkAxonCompatibility()` | `checkSourceCompatibility()` | **ALIAS-READY** | `SourceCompatibility` exists; add function alias |
| `axonHostUrlForRepo()` | `sourceHostUrlForRepo()` | **RENAME-LATER** | No external callers confirmed; rename with directory |
| `packages/connectors/src/axon/` | `packages/connectors/src/source/` | **RENAME-LATER** | Blocked by stitcher interface debt (see `source-compat-checklist.md §Stitcher`) |

---

## Developer API — types (connectors package)

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `AxonNode` | `SourceNode` | **DONE** | `SourceNode` alias exported (HOR-64) |
| `AxonSearchResult` | `SourceSearchResult` | **DONE** | Alias exported (HOR-64) |
| `AxonCypherResult` | `SourceCypherResult` | **DONE** | Alias exported (HOR-64) |
| `AxonImpactResult` | `SourceImpactResult` | **DONE** | Alias exported (HOR-64) |
| `AxonDiffResult` | `SourceDiffResult` | **DONE** | Alias exported (HOR-64) |
| `AxonOverview` | `SourceOverview` | **DONE** | Alias exported (HOR-64) |
| `AxonHostInfo` | `SourceHostInfo` | **DONE** | Alias exported (HOR-64) |
| `AxonHealth` | `SourceHealth` | **DONE** | Alias exported (HOR-64) |
| `CommunityRef` jsdoc comment (`packages/core/src/evidence.ts:108`) | — | **UPDATE** | Type name is already neutral; only the jsdoc says "Axon community node" — update comment text, no rename needed |

---

## Developer API — core package

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `PINNED_AXON_VERSION` | `PINNED_SOURCE_VERSION` | **ALIAS-READY** | Add const alias in `packages/core/src/version.ts`; keep original |
| `axon` Zod key in `RepositoryConfig` | `source` | **FROZEN** | Parses user config; rename requires migration shim for `axon.hostUrl` |

---

## Database schema

| Current name | Proposed Horus name | Status | Migration note |
|---|---|---|---|
| `axonStatus` column (`repositories` table) | `sourceStatus` | **RENAME-LATER** | Requires a Drizzle migration file; gate behind startup migration |

---

## Docs and internal naming

| Current surface | Proposed change | Status | Migration note |
|---|---|---|---|
| README: "Axon is the default source-intelligence backend" | Add "source-intelligence" framing; keep "Axon" label | **UPDATE** | No API change |
| `docs/architecture.md`: "Axon" throughout | Add "source-intelligence" framing alongside | **UPDATE** | No API change |
| `docs/connector-setup.md`: `--axon` examples | Note `--source-url` alias when it lands | **UPDATE** | After CLI alias (ALIAS-READY) ships |
| `docs/source-intelligence-boundary.md` | Reference inventory as primary enumeration | **UPDATE** | Low priority |
| `axon/contract.test.ts` and related test files | Rename with directory | **RENAME-LATER** | Bundle with `axon/` → `source/` directory rename |
| `AxonHttpClient` mock in `stitch.test.ts` | Update when public name changes | **RENAME-LATER** | After stitcher interface debt resolved |
| `makeAxon()` test helper in `stitch.test.ts` | `makeSourceClient()` | **RENAME-LATER** | After public API rename |
| Code comments referencing "Axon" in engine/stitcher | Update opportunistically | **UPDATE** | No blocking; update as files are touched |
| `query: 'axon:BullMQWorkerConfig'` in replay fixture | — | **FROZEN** | Backend wire query value; not a naming surface |
| `docs/axon-compat.md`, `docs/axon-round-2.md` | — | **FROZEN** | Historical records; no rename needed |

---

## Summary counts

| Status | Count |
|--------|-------|
| FROZEN | 12 |
| ALIAS-READY | 10 |
| DONE | 9 |
| RENAME-LATER | 7 |
| UPDATE | 8 |

| **Total** | **46** |

**Immediate safe actions (no blockers, no compat risk):** 10 ALIAS-READY items and 8 UPDATE items — all additive.

**Hard gates before any rename:**
1. `axon.hostUrl` config key — needs migration shim (separate ticket).
2. `packages/connectors/src/axon/` directory — needs stitcher interface fix first.
3. `axonStatus` DB column — needs migration file.
4. `axon` binary name / `axoniq` package — cannot be changed (external).
