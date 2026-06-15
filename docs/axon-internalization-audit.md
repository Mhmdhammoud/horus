# Axon internalization audit (HOR-135)

Complete reference map for consuming Axon into Horus. This document supersedes the
partial audits in `docs/axon-surface-inventory.md` (HOR-79) and
`docs/source-naming-decision-table.md` (HOR-81) by capturing current state and
mapping every item to its migration ticket.

Follow-up tickets work from this file — not from guessing.

---

## How to read this table

| Column | Meaning |
|--------|---------|
| **Surface** | The Axon reference in its current form |
| **File(s)** | Location(s) in the repo |
| **v0.1 blocking** | ✓ = users will see "Axon" as the product name on a v0.1 release |
| **Ticket** | The HOR-42 child ticket that owns the migration |

---

## Category 1 — User-visible: must become Horus

These appear in terminal output, docs, or flags read/typed by a user.
Items marked **v0.1 blocking** gate the HOR-120 done checklist.

| Surface | File(s) | v0.1 blocking | Ticket |
|---------|---------|:---:|--------|
| `--axon <url>` flag on `horus init` / all error hints | `cli/src/index.ts:89`, `commands/init.ts:20`, `commands/doctor.ts:84`, `commands/readiness.ts:189` | ✓ | HOR-138 |
| Error messages: `start it with: axon host --port 8420` (binary command in red text) | `commands/architecture.ts:18`, `blast-radius.ts:17`, `changes.ts:18`, `explain.ts:15`, `onboard.ts:30`, `simulate.ts:50`, `investigate.ts:81` | — | FROZEN — `axon` is the external binary the user must run; allowed per HOR-119 branding check |
| `` `axon` not found on PATH `` (binary check message) | `commands/index-repo.ts:136` | — | FROZEN — binary name; allowed per branding check |
| `axon.hostUrl` config key in user-created `.horus/config.json` | `config/horus.config.ts:31,62,99`, `core/config.ts:36` | ✓ | HOR-137 (migration shim) |
| `horus init --axon <url>` suggestion in doctor + readiness output | `commands/doctor.ts:84`, `commands/readiness.ts:189` | ✓ | HOR-138 |
| `axon host --port N` and `axon index .` printed in setup output | `commands/setup.ts:122,136` | — | FROZEN — binary commands the user must run |
| `uv tool install axoniq==${PINNED_AXON_VERSION}` in setup/readiness | `commands/setup.ts:32,33,46,47`, `commands/readiness.ts:133,141` | — | FROZEN — PyPI package name; Horus cannot rename |
| `docs/troubleshooting.md`: "The Axon source-intelligence backend" as product name | `docs/troubleshooting.md:118,122,138,163,175,334` | ✓ | HOR-143 |
| `docs/connector-setup.md`: "Source intelligence comes from Axon" section and `--axon` flag examples | `docs/connector-setup.md:62,79,80,83,344,412` | ✓ | HOR-143 |
| `docs/demo.md`: "installs the Axon source-intelligence backend" and setup table using "Axon" as product label | `docs/demo.md:14,114,127,262-268,280` | ✓ | HOR-143 |
| `docs/install.md`: "Axon source-intelligence backend is reachable" | `docs/install.md:236` | ✓ | HOR-143 |
| `scripts/demo-setup.sh`: section header "Source-intelligence host (Axon)" and user-facing output | `scripts/demo-setup.sh:145-163,186,208` | ✓ | HOR-143 |
| `AXON_HOST_URL` env var name in contract test comment (user instruction comment) | `connectors/src/axon/provider.contract.test.ts:8` | — | HOR-145 |

---

## Category 2 — Internal compatibility shim: temporarily allowed

These are internal names that must eventually become Horus names but have no
user-visible impact today. They are safe to leave until the owning migration ticket.

| Surface | File(s) | Status today | Ticket |
|---------|---------|:---:|--------|
| `packages/connectors/src/axon/` directory | `connectors/src/axon/` | Shim dir | HOR-136 (introduce boundary) → HOR-139 (rename to `source/`) |
| `AxonHttpClient`, `AxonHttpError`, `AxonClientOptions` | `axon/client.ts` | Not aliased | HOR-136 — add `SourceHttpClient` etc. |
| `AxonCodeProvider` | `axon/provider.ts` | Not aliased | HOR-136 — add `SourceCodeProvider` |
| `axonAvailable()`, `getAxonVersion()`, `readAxonHostUrl()` | `axon/lifecycle.ts` | Not aliased | HOR-136 — add `sourceAvailable()` etc. |
| `checkAxonCompatibility()` | `connectors/src/compat.ts` | `SourceCompatibility` type DONE; fn not aliased | HOR-136 — add `checkSourceCompatibility()` |
| `axonHostUrlForRepo()` | `connectors/src/factory.ts:160` | Not aliased | HOR-136 |
| `PINNED_AXON_VERSION` | `core/src/version.ts:9` | Not aliased | HOR-136 — add `PINNED_SOURCE_VERSION` |
| `axon` Zod key in `RepositoryConfig` (parsed from user config) | `core/config.ts:36,159` | FROZEN until migration shim | HOR-137 |
| `axonHostUrl` resolved field on `ResolvedRepo` | `core/config.ts:182,322` | FROZEN downstream of config key | HOR-137 |
| `AxonNode`, `AxonSearchResult`, `AxonCypherResult`, `AxonImpactResult`, `AxonDiffResult`, `AxonOverview`, `AxonHostInfo`, `AxonHealth` | `axon/types.ts` | `Source*` aliases DONE (HOR-64) | Backing names stay until dir rename (HOR-139) |
| `AxonCompatibility` type | `connectors/src/compat.ts` | `SourceCompatibility` DONE (HOR-50) | Backing name stays until dir rename |
| `axonStatus` DB column on `repositories` table | `db/src/schema.ts:37` | Not migrated | HOR-141 — add Drizzle migration |
| `axon list` comment in `db/src/schema.ts:30` | `db/src/schema.ts:30` | Comment only | Update with HOR-141 |
| `re-export * from './axon/index.js'` | `connectors/src/index.ts:10,13` | Required for compat | Update when dir renames (HOR-139) |
| `AxonCommunityNode` jsdoc in `evidence.ts` | `core/src/evidence.ts:108` | Comment only; type name is `CommunityRef` | HOR-141 — update comment |

---

## Category 3 — Upstream/attribution: must remain

These references cannot be changed because they refer to an external tool, PyPI package,
or are historical record. Do not attempt to rename these in follow-up tickets.

| Surface | File(s) | Reason |
|---------|---------|--------|
| `axon host --port N` / `axon analyze .` / `axon --version` / `axon serve` | all CLI files | External binary; Horus cannot rename |
| `axoniq` (PyPI package name) | `setup.ts`, `readiness.ts`, docs | Upstream; Horus has no control |
| `.axon/` on-disk directory and `.axon/host.json` | `lifecycle.ts:43,62` | Created by axon binary; not a Horus path |
| `query: 'axon:BullMQWorkerConfig'` | `engine/src/replay-fixture.ts:118` | Backend wire-protocol query string; not a naming surface |
| `docs/axon-compat.md` | `docs/axon-compat.md` | Historical validation record |
| `docs/axon-round-2.md` | `docs/axon-round-2.md` | Historical validation record |
| `docs/implementation-plan.md` | `docs/implementation-plan.md` | Historical implementation notes |
| `docs/axon-branding-audit-v0.1.md` | `docs/axon-branding-audit-v0.1.md` | Prior branding audit; historical |
| `docs/axon-surface-inventory.md` | `docs/axon-surface-inventory.md` | Prior HOR-79 inventory; historical |
| `docs/axon-migration-checklist.md` | `docs/axon-migration-checklist.md` | Prior HOR-80 checklist; superseded by this file |

---

## Category 4 — Dead/unused: should be removed

No items identified as clearly dead or unused at the time of this audit.
The `axon-migration-checklist.md` and `axon-surface-inventory.md` files are
historical records (category 3), not dead code — preserve them.

---

## Category 5 — Test fixtures requiring deliberate migration

These tests use the `axon` config key or `AxonHttpClient` directly. They must
track the migration of the thing they test — do not migrate in isolation.

| Surface | File(s) | Migrate when |
|---------|---------|--------------|
| `axon: { hostUrl: ... }` fixtures | `core/src/config.test.ts` (18 occurrences) | HOR-137 config key migration |
| `axonHostUrl` assertions | `core/src/config.test.ts:177,195,221,222` | HOR-137 |
| `_axonVersion`, `axonUrl` fixtures | `cli/src/commands/readiness.test.ts` (20 occurrences) | HOR-136 alias + HOR-138 rename |
| `axon: { hostUrl }` / `axon: 'http://...'` in init/exit fixtures | `cli/src/commands/exit-codes.test.ts:113,128` | HOR-137 config key migration |
| `axon: { hostUrl }` / `repo.axon.hostUrl` checks | `cli/src/commands/setup.test.ts:58,64,285-297` | HOR-137 |
| `axon: { hostUrl }` | `cli/src/commands/doctor.test.ts:63,98,392` | HOR-137 |
| `AxonHttpClient` import + `makeAxon()` helper | `stitcher/src/stitch.test.ts:11,17-29` | HOR-136 boundary alias |
| `contracts` tests in `connectors/src/axon/` | `contract.test.ts`, `provider.contract.test.ts`, `schema.contract.test.ts` | HOR-139 directory rename |

---

## Items resolved since HOR-79 / HOR-81

These were previously listed as open and are now DONE:

| Item | Done in | Notes |
|------|---------|-------|
| `.horus/axon-host.log` → `.horus/source-host.log` | HOR-119 | Log file renamed; index-repo.ts:159 updated |
| `SourceCompatibility` type alias | HOR-50 | Exported in `connectors/src/compat.ts` |
| `Source*` type aliases for all wire types | HOR-64 | `SourceNode`, `SourceSearchResult`, etc. all exported |
| `scripts/check-branding.sh` branding regression gate | HOR-119 | Allowlist-based scanner exits 0 on clean tree |

---

## Search summary

Commands run for this audit:

```bash
# All files containing axon references
grep -ril "axon" --include="*.ts" --include="*.js" --include="*.json" \
  --include="*.md" --include="*.sh" --include="*.yaml" . \
  | grep -v node_modules | grep -v .git | sort
# → 87 files (includes audit file itself and files added post-search)

# Total reference lines (source + docs, no lockfile/drizzle meta)
grep -ri "axon" --include="*.ts" --include="*.js" --include="*.json" \
  --include="*.md" --include="*.sh" --include="*.yaml" . \
  | grep -v node_modules | grep -v .git | grep -v pnpm-lock | grep -v "drizzle/meta" | wc -l
# → ~1,188 lines
```

---

## Migration ticket map

| Ticket | Scope |
|--------|-------|
| **HOR-136** | Introduce Horus source-intelligence boundary: `Source*` client aliases, `PINNED_SOURCE_VERSION`, `sourceAvailable()` etc. |
| **HOR-137** | Migrate `.axon` runtime state to Horus-owned path; config key `axon.hostUrl` → `source.hostUrl` with shim |
| **HOR-138** | Replace `horus init --axon` and lifecycle CLI commands with Horus source commands |
| **HOR-139** | Rename `connectors/src/axon/` → `connectors/src/source/` after HOR-136 aliases land |
| **HOR-140** | Rebrand source-intelligence UI assets/metadata |
| **HOR-141** | Internalize package metadata; `axonStatus` DB column migration |
| **HOR-142** | Add Horus API/client shims over Axon-compatible routes |
| **HOR-143** | Rewrite user-facing docs and demo scripts to remove Axon as user concept |
| **HOR-144** | Final no-user-visible-Axon check + allowlist gate |
| **HOR-145** | Migrate `AXON_HOST_URL` env vars and service identifiers |
| **HOR-146** | Remove Axon naming from install and release artifact surfaces |
