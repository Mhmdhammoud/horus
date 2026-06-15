# Axon-facing surface inventory (HOR-79)

Audit of every place in the Horus monorepo that exposes Axon naming, commands,
config keys, or source-intelligence assumptions. No renames in this ticket —
this file feeds follow-up tickets (HOR-80, HOR-81).

**Categories**
- **User-facing** — visible in terminal output, CLI flags, user config, docs
- **Developer-facing** — exported types, function names, internal APIs
- **Internal-only** — test fixtures, code comments, log strings

**Recommended next action**
- `stay` — must not change; hard compatibility dependency
- `alias` — add a Horus-first alias now, keep Axon name for compatibility
- `rename` — rename in a later targeted ticket after alias or shim is in place
- `update` — doc/comment wording can be improved without a compatibility risk

---

## 1. User-facing

| Surface | File(s) | Notes | Next action |
|---------|---------|-------|-------------|
| Error messages: `start it with: axon host --port 8420` | `commands/architecture.ts`, `blast-radius.ts`, `changes.ts`, `explain.ts`, `onboard.ts`, `simulate.ts` | Printed to stderr when source-intelligence host is unreachable; `axon` is the binary name | `stay` — `axon` is the external binary name the user must run |
| Error message in `investigate.ts`: `start it with: axon host (${axonUrl})` | `commands/investigate.ts:81` | Same pattern | `stay` |
| CLI flag `--axon <url>` on `horus init` | `cli/src/index.ts:67`, `commands/init.ts:20` | User-visible flag name | `alias` — add `--source-url` alias; keep `--axon` for back-compat |
| Doctor output: `pass --axon <url> to \`horus init\`` | `commands/doctor.ts:64` | Human-readable hint | `update` — rephrase when `--source-url` alias lands |
| Setup command: installs `axoniq==${PINNED_AXON_VERSION}` | `commands/setup.ts:27,28,41,42` | `axoniq` is the PyPI package name; Horus cannot rename it | `stay` — upstream package name |
| Status output: `pinned backend: ${PINNED_AXON_VERSION}` | `commands/status.ts:140` | Human-readable status line | `update` — rephrase to `pinned source-intelligence: ...` |
| Index error: `` `axon` not found on PATH `` | `commands/index-repo.ts:136` | Binary name check | `stay` — `axon` is the external binary |
| Index log reference: `.horus/axon-host.log` | `commands/index-repo.ts:159` | Log file path printed in error | `rename` — rename file to `.horus/source-host.log` in a later ticket |
| Config key `axon.hostUrl` in user config (`horus init --axon`) | `config/horus.config.ts:31,62,99`, `core/config.ts:34` | Written into `.horus/config.json` by `horus init`; read by every command | `stay` — breaking change for existing configs; needs migration shim first |
| Resolved field `axonHostUrl` in env context | `core/config.ts:180,320` | Injected into every investigation context | `stay` — downstream of config key; rename with config migration |
| README "Axon is the default source-intelligence backend" section | `README.md:160–168` | Describes Axon as backend; user documentation | `update` — can add "source-intelligence" framing while keeping Axon name |
| `connector-setup.md`: `--axon` flag examples and "Axon host" instructions | `docs/connector-setup.md:62,79,83` | User setup guide | `update` — add `--source-url` alias note when alias lands |

---

## 2. Developer-facing

| Surface | File(s) | Notes | Next action |
|---------|---------|-------|-------------|
| `packages/connectors/src/axon/` directory | `connectors/src/axon/` | Entire subdirectory named after the backend | `rename` — rename to `source/` in a later refactor ticket; re-export from compat shim |
| `AxonHttpClient`, `AxonHttpError`, `AxonClientOptions` | `axon/client.ts`, exported via `index.ts` | Core HTTP transport types; imported by CLI, stitcher, engine | `alias` — add `SourceHttpClient` etc.; keep `Axon*` for one release |
| `AxonCodeProvider` | `axon/provider.ts`, exported via `index.ts` | CodeProvider implementation | `alias` — add `SourceCodeProvider`; keep `AxonCodeProvider` |
| `AxonCompatibility`, `checkAxonCompatibility()` | `connectors/src/compat.ts` | Version check; `SourceCompatibility` alias already added | `alias` — `SourceCompatibility` exists; add `checkSourceCompatibility()`; keep `Axon*` |
| `axonAvailable()`, `getAxonVersion()`, `readAxonHostUrl()` | `axon/lifecycle.ts`, exported via `index.ts` | Lifecycle functions; imported by CLI commands | `alias` — add `sourceAvailable()` etc.; keep `axon*` names |
| `axonHostUrlForRepo()` | `connectors/src/factory.ts:160` | Factory helper | `rename` — rename to `sourceHostUrlForRepo()` |
| `PINNED_AXON_VERSION` | `core/src/version.ts:9` | Pinned backend version constant; imported widely | `alias` — add `PINNED_SOURCE_VERSION`; keep `PINNED_AXON_VERSION` for one cycle |
| `AxonNode`, `AxonSearchResult`, `AxonCypherResult`, `AxonImpactResult`, `AxonDiffResult`, `AxonOverview`, `AxonHostInfo`, `AxonHealth` | `axon/types.ts` | Wire-shape types; `Source*` aliases already exported below each | `stay` — `Source*` aliases exist; backing `Axon*` names stay until directory rename |
| `axon` Zod schema key in `RepositoryConfig` | `core/config.ts:34` | Parsed from user config; drives `axonHostUrl` resolution | `stay` — changing breaks existing `.horus/config.json` files |
| `axonStatus` column in `repositories` DB table | `db/src/schema.ts:37` | Drizzle column; would require a migration | `rename` — create a targeted DB migration ticket |
| `AxonCommunityNode` evidence type | `core/src/evidence.ts:108` | Evidence node type for community nodes | `rename` — rename to `SourceCommunityNode` in a later types cleanup |
| Comments in `engine.ts`, `ownership.ts`, `refine.ts`, `changes.ts` referencing "Axon" | `engine/src/*.ts` | Internal code comments only | `update` — low priority; update as files are touched |

---

## 3. Internal-only

| Surface | File(s) | Notes | Next action |
|---------|---------|-------|-------------|
| Test fixtures using `axon: { hostUrl: ... }` | `core/src/config.test.ts` (multiple) | Mirrors config schema; will update when config key renames | `stay` — must match the config schema |
| `axon/contract.test.ts`, `provider.contract.test.ts`, `schema.contract.test.ts` | `connectors/src/axon/` | Contract tests named after directory | `rename` — rename when directory renames |
| `AxonHttpClient` mock in `stitch.test.ts` | `stitcher/src/stitch.test.ts` | Test helper; tracks public API name | `rename` — update when `AxonHttpClient` alias lands |
| `makeAxon()` helper in `stitch.test.ts` | `stitcher/src/stitch.test.ts` | Local test helper | `rename` — rename to `makeSourceClient()` when public API renames |
| `query: 'axon:BullMQWorkerConfig'` in `replay-fixture.ts` | `engine/src/replay-fixture.ts:118` | Value passed to Axon wire protocol; not an internal symbol name | `stay` — this is a backend query string, not a naming surface |
| Code comments in engine and stitcher: "Axon search", "Axon's static graph", etc. | `engine/src/`, `stitcher/src/` | Informational comments | `update` — update opportunistically; not blocking |
| `docs/axon-compat.md`, `docs/axon-round-2.md` | `docs/` | Historical validation/contract records | `stay` — historical records; no rename needed |

---

## 4. Docs

| File | What it exposes | Notes | Next action |
|------|----------------|-------|-------------|
| `docs/architecture.md` | "Axon" as the source-intelligence backend throughout | Primary architecture reference | `update` — add "source-intelligence" framing; Axon name stays as backend label |
| `docs/source-intelligence-boundary.md` | Surface audit from HOR-50 | Overlaps with this document; describes the boundary | `update` — reference this inventory as the primary enumeration |
| `docs/source-compat-checklist.md` | Pre-change safety checklist for Axon surfaces | Companion to this doc | `stay` — still valid as a change-gate checklist |
| `docs/connector-setup.md` | `--axon <url>`, "Axon host", install steps | User-facing setup guide | `update` — update wording as aliases land |
| `config/horus.config.ts` | `axon: { hostUrl: ... }` example config keys | Template shown to users | `stay` until config migration shim exists |

---

## Summary counts

| Category | stay | alias | rename | update |
|----------|------|-------|--------|--------|
| User-facing | 5 | 1 | 1 | 5 |
| Developer-facing | 4 | 5 | 3 | 1 |
| Internal-only | 3 | 0 | 3 | 2 |
| Docs | 2 | 0 | 0 | 3 |
| **Total** | **14** | **6** | **7** | **11** |

**38 surfaces total.** The largest compatibility dependencies are:
1. The `axon` config key and `axonHostUrl` resolved field — need a migration shim before any rename.
2. The `axoniq` PyPI package name — cannot be renamed (upstream).
3. The `axon` binary name in error messages — cannot be renamed (external tool).

`Source*` type aliases and `checkSourceCompatibility` are partially done (HOR-64, HOR-50).
The next natural step is HOR-80 (migration checklist) and HOR-81 (naming decision table).
