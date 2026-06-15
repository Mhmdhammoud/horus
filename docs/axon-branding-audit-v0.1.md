# Axon branding audit — v0.1 gate (HOR-117)

Audit of remaining user-visible Axon references as of v0.1. Feeds HOR-118 (replacements).

The comprehensive historical inventory is `docs/axon-surface-inventory.md` (HOR-79).
This document focuses on **v0.1 blocking** decisions only.

**Blocking** = must change before v0.1 ships; user sees "Axon" branding instead of "Horus" or "source-intelligence"
**Acceptable** = `axon` refers to the actual external binary name (cannot rename) or is internal-only

---

## Search commands used

```bash
# CLI source — user-visible output strings
grep -rni "\baxon\b" packages/cli/src/ --include="*.ts" | grep "pc\.\|console\." | grep -v "axoniq"

# CLI help text in running binary
node apps/horus/dist/index.cjs --help       # → no "Axon" found
node apps/horus/dist/index.cjs setup --help # → no "Axon" found
node apps/horus/dist/index.cjs stop --help  # → no "Axon" found
node apps/horus/dist/index.cjs setup        # → "source-intelligence backend" ✓

# README
grep -ni "\baxon\b" README.md

# Docs
grep -rni "\baxon\b" docs/ --include="*.md" | grep -v "axoniq"
```

---

## 1. User-visible CLI output — BLOCKING

These strings are printed to users at runtime and say "Axon" where "source-intelligence" or "source-intelligence host" is appropriate.

| # | File | Line | Current string | Decision | Notes |
|---|------|------|----------------|----------|-------|
| U1 | `setup.ts` | 115 | `Axon host unreachable for <name>` | **BLOCK — replace** | Shown when `horus setup` finds a repo host down |
| U2 | `setup.ts` | 120 | `start an Axon host for this repo:` | **BLOCK — replace** | Prose label above the `axon host` command |
| U3 | `setup.ts` | 130 | `Axon host running but <name> is not indexed` | **BLOCK — replace** | Shown when host runs but repo not indexed |
| U4 | `architecture.ts` | 18 | `start it with: axon host --port 8420` | **acceptable** | `axon` is the external binary name; keep |
| U5 | `blast-radius.ts` | 17 | `start it with: axon host --port 8420` | **acceptable** | same |
| U6 | `changes.ts` | 18 | `start it with: axon host --port 8420` | **acceptable** | same |
| U7 | `explain.ts` | 15 | `start it with: axon host --port 8420` | **acceptable** | same |
| U8 | `onboard.ts` | 30 | `start it with: axon host --port 8420` | **acceptable** | same |
| U9 | `simulate.ts` | 50 | `start it with: axon host --port 8420` | **acceptable** | same |
| U10 | `investigate.ts` | 81 | `start it with: axon host (<url>)` | **acceptable** | same |
| U11 | `index-repo.ts` | 136 | `` `axon` not found on PATH `` | **acceptable** | binary name check; must say `axon` |
| U12 | `index-repo.ts` | 148 | `already analyzed (.axon present)` | **acceptable** | `.axon` is the on-disk directory created by the axon binary |
| U13 | `index-repo.ts` | 159 | `see .horus/axon-host.log` | **BLOCK — rename** | log file name shown to users; rename to `source-host.log` (low effort) |
| U14 | `setup.ts` | 122 | `axon host --port ${port}` (command in hint) | **acceptable** | actual command users must run |
| U15 | `setup.ts` | 136 | `axon index .` (command in hint) | **acceptable** | actual command |

**Summary: 3 blocking (U1, U2, U3, U13), 12 acceptable**

---

## 2. CLI flag / help text

| # | Surface | Current | Decision | Notes |
|---|---------|---------|----------|-------|
| F1 | `horus init --axon <url>` flag | `--axon <url>` option | **acceptable** | Config key name; cannot rename without migration shim |
| F2 | Doctor hint: `pass --axon <url> to horus init` | doctor.ts:70 | **acceptable** | Correct flag name; update when alias lands |

No blocking help-text issues found in the compiled binary output.

---

## 3. README

| # | Section | Decision | Notes |
|---|---------|----------|-------|
| R1 | "Axon is the default source-intelligence backend" (heading) | **BLOCK — rephrase** | Section heading names Axon prominently; should say "Source-intelligence backend (Axon)" |
| R2 | Body paragraphs: "Axon can realistically be the…" | **acceptable** | Technical documentation; names the backend correctly |
| R3 | `axon analyze .` / `axon host --port 8420` code blocks | **acceptable** | These are the actual commands |
| R4 | Architecture table: "Axon as the default source-intelligence backend" | **acceptable** | Technical architecture doc |

**Summary: 1 blocking (R1), 3 acceptable**

---

## 4. User-facing docs

| # | File | Decision | Notes |
|---|------|----------|-------|
| D1 | `docs/connector-setup.md` — "Axon host" in setup guide | **acceptable** | Names the backend correctly in technical context |
| D2 | `docs/install.md` | **no Axon found** | Clean ✓ |
| D3 | `docs/v0.1-readiness-gate.md` | **no Axon found** | Clean ✓ |
| D4 | `docs/release-checklist.md` | **no Axon found** | Clean ✓ |
| D5 | `docs/demo.md` | defer to HOR-118 search | Not audited in this pass |

---

## 5. Compatible internals — no change required at v0.1

These are explicitly justified as acceptable at v0.1:

| Surface | Justification |
|---------|---------------|
| `axon.hostUrl` config key in `.horus/config.json` | Breaking change; needs migration shim — post-v0.1 |
| `axonHostUrl` resolved field | Downstream of config key |
| `axoniq` PyPI package name | Upstream package; cannot rename |
| `AxonHttpClient`, `AxonMcpClient` etc. | Developer-facing types; `Source*` aliases exist (HOR-64) |
| `packages/connectors/src/axon/` directory | Internal module path; rename post-v0.1 |
| `PINNED_AXON_VERSION` constant | Internal; `PINNED_SOURCE_VERSION` alias can be added later |
| `.axon/` on-disk directory | Created by the external `axon` binary; cannot rename |
| `axon-host.log` filename | Shown to users (see U13 above — mark for rename in HOR-118) |
| Test file describe blocks referencing "Axon" | Developer-visible only |

---

## v0.1 blocking summary

| ID | Location | What to change | Owner |
|----|----------|----------------|-------|
| U1 | `setup.ts:115` | `"Axon host unreachable"` → `"Source-intelligence host unreachable"` | HOR-118 |
| U2 | `setup.ts:120` | `"start an Axon host for this repo:"` → `"start a source-intelligence host:"` | HOR-118 |
| U3 | `setup.ts:130` | `"Axon host running but"` → `"Source-intelligence host running but"` | HOR-118 |
| U13 | `index-repo.ts:159` | `.horus/axon-host.log` → `.horus/source-host.log` (file + ref) | HOR-118 |
| R1 | `README.md:160` | Section heading: add "(Axon)" as parenthetical, not the primary label | HOR-118 |

**5 blocking items. All in CLI source or README. HOR-118 owns the replacements.**
