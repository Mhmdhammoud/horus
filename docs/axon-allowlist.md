# Axon Compatibility Allowlist

This document lists every intentional reference to "Axon" that remains in the
Horus codebase after the HOR-42 migration. Each entry is categorized and justified.
The `scripts/check-branding.sh` branding check uses this list to determine which
occurrences are safe and which are regressions.

**Updated after:** HOR-144

---

## How to read this list

Each section is one category of allowed reference. When a reference is removed
(the compat shim is dropped, the flag is renamed, the migration is complete),
remove it from the relevant section. When a new intentional reference is added,
add it with its category and location.

---

## 1. Binary name and PyPI package (upstream — immutable)

Horus embeds the `axon` binary as its source-intelligence backend via the
`axoniq` PyPI package. Neither name can be changed without a coordinated
upstream release. Every place these strings appear is governed by that
upstream constraint, not a Horus branding decision.

| String | Location | Notes |
|--------|----------|-------|
| `axon` (binary name) | `scripts/demo-setup.sh`, `packages/connectors/src/axon/lifecycle.ts` | The installed command on the user's PATH |
| `axon host` | Any script or doc that shows how to start the backend | Subcommand of the `axon` binary |
| `axon analyze` | Any script or doc that shows how to index a repo | Subcommand of the `axon` binary |
| `axon serve` | Any script or doc that shows how to start MCP mode | Subcommand of the `axon` binary |
| `axon --version` | `packages/connectors/src/axon/lifecycle.ts`, `packages/cli/src/commands/setup.ts` | Binary version probe |
| `axoniq` | `docs/install.md`, `scripts/demo-setup.sh`, `docs/release-checklist.md` | PyPI package name (upstream) |

---

## 2. CLI flag (--axon)

The `--axon <url>` flag in `horus init` and `horus index` is the live CLI
interface for specifying the source-intelligence host URL. It cannot be renamed
until a config migration shim ships that accepts both `--axon` and `--source`.

| String | Location | Notes |
|--------|----------|-------|
| `--axon <url>` flag | `packages/cli/src/index.ts`, `packages/cli/src/commands/index-repo.ts` | Live CLI flag |
| `--axon` reference | `docs/connector-setup.md`, `docs/troubleshooting.md` | Docs showing the flag usage |

---

## 3. Config schema compatibility keys

These config keys are read from `.horus/config.json` and `horus.config.js` for
backwards compatibility with existing configurations. New configs use
`source.hostUrl`, but files created before the migration may still have `axon.hostUrl`.

| String | Location | Notes |
|--------|----------|-------|
| `axon.hostUrl` | `packages/core/src/config.ts` | Deprecated compat alias; read alongside `source.hostUrl` |
| `axon.pinnedVersion` | `packages/core/src/config.ts` | Live global config key for pinning the binary version |
| `repo.axon` | `packages/connectors/src/factory.ts` | Config property access (compat read path) |

---

## 4. On-disk paths written by the axon binary

The `axon` binary writes its runtime state to `.axon/host.json`. Horus reads
this file to locate a running source-intelligence host. The path cannot be
changed without coordinating a binary-side change.

| String | Location | Notes |
|--------|----------|-------|
| `.axon/` directory | `packages/connectors/src/axon/lifecycle.ts`, `packages/connectors/src/axon/source-boundary.ts` | On-disk artifact of the axon binary |
| `.axon/host.json` | `packages/connectors/src/axon/lifecycle.ts` | Host state file written by the binary |

---

## 5. Internal compatibility layer (packages/connectors/src/axon/)

The `packages/connectors/src/axon/` directory contains the Axon-compatible
source-intelligence provider. These are internal implementation details — public
Horus code uses `Source*` type aliases defined in `source-boundary.ts`. The
`Axon*` backing types, HTTP client, and contract tests live here and are never
exposed to users.

| String | Location | Notes |
|--------|----------|-------|
| `packages/connectors/src/axon/*.ts` | All files in this directory | Internal compat layer |
| `Axon*` TypeScript type names | `packages/connectors/src/axon/types.ts` | Backing types for `Source*` public aliases |
| `"Axon request failed"` | `packages/connectors/src/axon/client.ts` | Internal HTTP error thrown to callers; not surfaced in normal CLI output |
| `"Axon host responded"` / `"Axon host unreachable"` | `packages/connectors/src/axon/provider.ts` | Health-check detail strings in the internal `HealthStatus` object |

---

## 6. Code comments in packages (not user-visible)

Comments in the following files refer to Axon as the implementation backing.
These are developer notes, never rendered in user output.

| Location | Example pattern | Notes |
|----------|----------------|-------|
| `packages/connectors/src/factory.ts` | `// Axon connector is configured for...` | Internal plumbing comments |
| `packages/connectors/src/contract.ts` | `// Full contract for a code-graph provider (Axon).` | Internal interface doc |
| `packages/connectors/src/index.ts` | `// Axon provider (HTTP/MCP transport only)` | Module comment |
| `packages/connectors/src/git/provider.ts` | `// complement to Axon queries` | Inline note |
| `packages/core/src/version.ts` | `// The exact Axon version Horus is validated against` | Version constant comment |
| `packages/stitcher/src/*.ts` | `// Axon's static flow graph terminates at...` | Algorithm explanation comments |
| `packages/cli/src/commands/*.ts` | `// Axon analyze/host lifecycle`, `// Axon host(s) spawned by Horus` | Command implementation comments |

---

## 7. Test file references (not user-visible)

Test describe blocks and inline comments refer to Axon as the component being
tested. These are test infrastructure, not product output.

| Location | Example pattern | Notes |
|----------|----------------|-------|
| `packages/connectors/src/axon/*.contract.test.ts` | `"Axon schema contract"`, `"Axon HTTP API contract"` | Contract test suite names |
| `packages/cli/src/commands/readiness.test.ts` | `"Axon at pinned version"`, `"Axon binary not found"` | Readiness check test descriptions |
| `packages/cli/src/commands/setup.test.ts` | `"runSetup — Axon binary not found"`, `"runSetup — Axon host unreachable"` | Setup command test descriptions |
| `packages/cli/src/commands/exit-codes.test.ts` | `// no live Axon host` | Inline test comment |

---

## 8. Internal developer documentation (not user-facing)

The following documents describe the Axon compatibility boundary, migration plan,
and architectural decisions. They are not product documentation for Horus users.

| Document | Axon references | Notes |
|----------|----------------|-------|
| `docs/architecture.md` | Extensive — original design analysis that named Axon as the backend | Historical design record; not indexed in user help or public site |
| `docs/source-intelligence-boundary.md` | Full audit of the Axon surface after HOR-42 | Internal migration safety pass document |
| `docs/source-compat-checklist.md` | Internal checklist for changing the compat layer | Developer reference, not user docs |
| `docs/v0.1-readiness-gate.md` | References "Axon host" as the technical backend component | Release gate document; line 26 explicitly tests that `--version` does NOT print "Axon" |
| `docs/cli-exit-codes.md` | One comment: "no live Axon host" in offline test context | Internal dev doc about test isolation |

---

## 9. Axon fork source files (out-of-scope for Horus branding)

The Axon upstream fork is a separate repository (not part of the Horus monorepo).
Its user-visible strings (`"Axon — Graph-powered code intelligence engine"`,
`"Axon UI running at ..."`, etc.) are documented in
`docs/source-intelligence-boundary.md` but are outside Horus's control.

---

## Updating this list

When a new intentional Axon reference is introduced (a compatibility shim, a
migration step, an upstream constraint), add it here with:

- The exact string or pattern
- The file location
- The category: one of the section numbers above
- A one-line justification

When a reference is removed (migration complete, flag renamed, compat shim
dropped), delete it from the relevant section and note it in the commit message.

The `scripts/check-branding.sh` allowlist patterns must be kept in sync with
categories 1–5. Categories 6–9 are not checked by the script (code comments,
test describe blocks, and out-of-scope repos are intentionally excluded from
automated checks).
