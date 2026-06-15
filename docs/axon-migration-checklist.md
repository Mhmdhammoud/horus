# Horus source-intelligence migration checklist (HOR-80)

Based on the surface inventory in `docs/axon-surface-inventory.md` (HOR-79).
Per-name decision table is in `docs/source-naming-decision-table.md` (HOR-81).
Companion safety checklist is in `docs/source-compat-checklist.md`.

This checklist is for planning only. **No renames happen in this document.**

---

## How to read this checklist

| Tier | Meaning |
|------|---------|
| **Immediate** | Can be done now — additive only (add alias, update wording) |
| **Later** | Rename after alias is in place and one release cycle has passed |
| **Never / Do not change** | Hard compatibility dependency; changing breaks users or the binary |

Each item notes the prerequisite, the owning area, and a suggested follow-up ticket scope.

---

## Tier 1 — Immediate (additive, no compat risk)

### 1a. CLI flag alias: `--source-url` for `horus init --axon`

- **What:** Add `--source-url` as an alias for the existing `--axon <url>` flag on `horus init`.
- **File:** `packages/cli/src/index.ts:67`, `commands/init.ts:20`
- **Compatibility:** Keep `--axon` — the alias only adds the new name.
- **Blocker:** None.
- **Suggested ticket:** "Add `--source-url` alias to `horus init` (keep `--axon`)" — 1–2 file change.

### 1b. Developer re-exports: `Source*` HTTP client types

- **What:** Export `SourceHttpClient`, `SourceHttpError`, `SourceClientOptions` from `packages/connectors/src/index.ts` as re-exports of the existing `Axon*` types.
- **File:** `packages/connectors/src/axon/client.ts`, `index.ts`
- **Compatibility:** `Axon*` names stay. New `Source*` names are additive.
- **Status:** `AxonNode` / `Source*` type aliases partially done (HOR-64). HTTP client aliases are not yet done.
- **Blocker:** None.
- **Suggested ticket:** "Add `SourceHttpClient` / `SourceHttpError` re-exports alongside `Axon*`" — additive export, no rename.

### 1c. Developer re-export: `SourceCodeProvider`

- **What:** Export `SourceCodeProvider` as re-export of `AxonCodeProvider`.
- **File:** `packages/connectors/src/axon/provider.ts`, `index.ts`
- **Compatibility:** `AxonCodeProvider` stays.
- **Blocker:** None.
- **Suggested ticket:** Bundle with 1b above.

### 1d. Developer re-exports: lifecycle functions

- **What:** Export `sourceAvailable()`, `getSourceVersion()`, `readSourceHostUrl()` as re-exports of `axonAvailable()`, `getAxonVersion()`, `readAxonHostUrl()`.
- **File:** `packages/connectors/src/axon/lifecycle.ts`, `index.ts`
- **Compatibility:** Original `axon*` names stay for one release.
- **Blocker:** None.
- **Suggested ticket:** Bundle with 1b and 1c.

### 1e. Developer alias: `PINNED_SOURCE_VERSION`

- **What:** Export `PINNED_SOURCE_VERSION` as alias of `PINNED_AXON_VERSION`.
- **File:** `packages/core/src/version.ts`
- **Compatibility:** `PINNED_AXON_VERSION` stays.
- **Blocker:** None.
- **Suggested ticket:** Bundle with 1b–1d ("Add Horus-first source-intelligence re-exports").

### 1f. Wording updates (no API changes)

These only touch strings and docs — no compat risk:

| Item | File | Change |
|------|------|--------|
| Status output: `pinned backend:` | `commands/status.ts:140` | Rephrase to `pinned source-intelligence:` |
| README: "Axon is the default backend" section | `README.md:160–168` | Add source-intelligence framing; keep Axon label |
| `docs/connector-setup.md` examples | `docs/connector-setup.md` | Note `--source-url` alias once 1a lands |
| `docs/architecture.md` | `docs/architecture.md` | Add source-intelligence framing alongside Axon label |

Suggested ticket: "Update wording: source-intelligence framing in status, README, and docs" — docs-only.

---

## Tier 2 — Later (rename after alias, one release gap)

**Prerequisite for all Tier 2 items:** The corresponding Tier 1 alias must have shipped and at least one release cycle must have passed so users/integrators have migrated.

### 2a. Rename `packages/connectors/src/axon/` → `source/`

- **What:** Rename the directory and update all internal imports.
- **Prerequisite:** 1b, 1c, 1d aliases shipped. All callers updated to use `Source*` names.
- **Compatibility risk:** Re-export `Source*` from old location for one more release (shim import).
- **Blocker:** Stitcher still imports `AxonHttpClient` directly (see `docs/source-compat-checklist.md §Stitcher interface debt`). Stitcher must accept `CodeProvider` interface first.
- **Suggested ticket:** "Rename `connectors/src/axon/` to `source/` with re-export shim" — medium scope, requires stitcher interface fix first.

### 2b. Rename `axonHostUrlForRepo()` → `sourceHostUrlForRepo()`

- **What:** Rename internal factory helper.
- **File:** `packages/connectors/src/factory.ts:160`
- **Prerequisite:** Callers updated to use alias name (or no external callers — verify).
- **Suggested ticket:** Bundle with 2a.

### 2c. Rename `.horus/axon-host.log` → `.horus/source-host.log`

- **What:** Change the log file path printed in error messages.
- **File:** `packages/cli/src/commands/index-repo.ts:159`
- **Compatibility:** Existing log files in user repos are renamed silently. Users reading the old path in docs will find a broken reference — update `connector-setup.md`.
- **Prerequisite:** Docs update in 1f has landed so users aren't confused.
- **Suggested ticket:** "Rename `.horus/axon-host.log` to `source-host.log`" — tiny, standalone.

### 2d. Update `CommunityRef` jsdoc comment (no rename needed)

- **What:** The interface at `packages/core/src/evidence.ts:108` is `CommunityRef` (the type name is already neutral). Only its jsdoc comment says "Axon community node" — update the comment to say "source-intelligence community node".
- **File:** `packages/core/src/evidence.ts:108`
- **Prerequisite:** None — jsdoc-only change.
- **Suggested ticket:** Bundle with 1f wording updates (docs-only, no compat risk).

### 2e. DB column rename: `axonStatus` → `sourceStatus`

- **What:** Rename the Drizzle ORM column in `repositories` table.
- **File:** `packages/db/src/schema.ts:37`
- **Compatibility:** Requires a DB migration file. Old column name will cause a schema mismatch if migration is not run.
- **Prerequisite:** Write migration, gate behind `horus migrate` or apply at startup.
- **Suggested ticket:** "DB migration: rename `axonStatus` to `sourceStatus` in repositories table" — medium, requires migration tooling review.

### 2f. Contract test files rename

- **What:** Rename `axon/contract.test.ts`, `provider.contract.test.ts`, `schema.contract.test.ts`.
- **File:** `packages/connectors/src/axon/`
- **Prerequisite:** Directory rename (2a) done first — file renames follow naturally.
- **Suggested ticket:** Bundle with 2a.

### 2g. Update doctor output hint

- **What:** Rephrase `pass --axon <url> to horus init` to mention `--source-url`.
- **File:** `packages/cli/src/commands/doctor.ts:64`
- **Prerequisite:** `--source-url` alias (1a) landed.
- **Suggested ticket:** Bundle with 1f wording update.

---

## Tier 3 — Never / Do not change

These surfaces have hard compatibility dependencies and must not be renamed without a migration shim or external coordination.

| Surface | File(s) | Why frozen |
|---------|---------|-----------|
| `axon` binary name in error messages | `architecture.ts`, `investigate.ts`, etc. | External binary name; Horus cannot rename it |
| `axoniq` PyPI package name | `commands/setup.ts` | Upstream package; Horus has no control |
| Config key `axon.hostUrl` | `core/src/config.ts:34` | Written into every user's `.horus/config.json` |
| Resolved field `axonHostUrl` | `core/src/config.ts:180,320` | Consumed by every CLI command and investigation context |
| CLI flag `--axon <url>` (removal) | `cli/src/index.ts:67` | Must stay alongside any `--source-url` alias |
| HTTP routes (`/api/health`, `/api/cypher`, etc.) | `axon/client.ts` | Wire protocol; removing breaks source-intelligence host |
| `.axon/` per-repo directory | `commands/index-repo.ts` | "Already analyzed" presence check |
| `.axon/host.json` → `host_url` key | `commands/stop.ts`, `index-repo.ts` | Live host detection |
| Axon wire queries (`axon:BullMQWorkerConfig` etc.) | `engine/src/replay-fixture.ts` | Backend query values; not a naming surface |
| Test fixtures: `axon: { hostUrl: ... }` | `core/src/config.test.ts` | Must mirror config schema; rename with config key |

**Config key migration prerequisite** (required before `axon.hostUrl` can ever be renamed):

1. Add `sourceHostUrl` alias in `core/config.ts` alongside `axonHostUrl`.
2. Write migration: read both keys, prefer new key, warn on old key presence.
3. Add deprecation warning printed once at startup.
4. After one release: remove old key in follow-up.

---

## Ordering summary

```
Immediate (no blockers):
  1a  --source-url alias on horus init
  1b-1e  Source* re-exports (client, provider, lifecycle, version constant)
  1f  Wording updates (status, README, docs)

Later (after 1b-1e shipped):
  2g  Doctor hint update (after 1a)
  2c  .horus/source-host.log (after 1f)
  2d  CommunityRef jsdoc comment update
  2e  DB column migration (axonStatus → sourceStatus)

Last (after 1b-1e and stitcher interface fix):
  2a  Directory rename: axon/ → source/
  2b  axonHostUrlForRepo() rename (bundle with 2a)
  2f  Contract test renames (bundle with 2a)

Never without migration shim:
  axon.hostUrl config key
  axonHostUrl resolved field
  axon binary name / axoniq PyPI package
```

---

## Compatibility constraints summary

1. **`axon` binary** — external; Horus cannot rename it. All error messages telling users to run `axon host` must stay.
2. **`axoniq` PyPI** — upstream; Horus cannot rename it. The `setup.ts` install command is frozen.
3. **Config key `axon.hostUrl`** — breaking for existing users. Needs migration shim before any rename can even be considered.
4. **`AxonHttpClient` in stitcher** — direct import blocks directory rename. Stitcher must accept an interface first (see `docs/source-compat-checklist.md §Stitcher interface debt`).
5. **HTTP wire protocol** — frozen entirely. All routes and response shapes must match the Axon fork.
