# Source-intelligence compatibility checklist (HOR-65)

Before changing any surface in the Axon-compatible fork or in the Horus connector
layer, work through this checklist. The authoritative surface inventory is in
`docs/source-intelligence-boundary.md`. The contract details are in `docs/axon-compat.md`.

---

## Quick rule

If the surface is in the **Frozen** column below → stop, read the blocker, do not rename.
If the surface is in the **Safe** column → proceed, run tests.

---

## Frozen surfaces — must not change

| Surface | Where in Horus | Why frozen |
|---------|---------------|------------|
| HTTP route `GET /api/health` | `client.ts` — 19 call sites | Health-check polling |
| HTTP route `POST /api/cypher` | `client.ts` — 10 call sites | All graph queries |
| HTTP route `POST /api/search` | `client.ts` — 5 call sites | Symbol search |
| HTTP route `GET /api/impact/:nodeId` | `client.ts` — 4 call sites | Impact analysis |
| HTTP route `POST /api/diff` | `client.ts` — 1 call site | Change detection |
| HTTP route `GET /openapi.json` | `client.ts` — 2 sites | Version pinning |
| `AxonNode` response shape | `types.ts` | All Cypher rows parsed into this |
| Cypher node labels: `File`, `Process`, `Community` | `provider.ts` | Hand-written queries |
| `CodeRelation` edge table + `rel_type` discriminator | `provider.ts` | All relationship queries |
| `rel_type` values: `calls`, `uses_type`, `member_of`, `defines`, `imports`, `coupled_with`, `step_in_process` | `provider.ts` | Each used in investigation Cypher |
| Node properties: `id`, `name`, `file_path`, `start_line`, `end_line`, `signature`, `language`, `class_name`, `content`, `is_dead` | `provider.ts` | Read in Cypher queries |
| Edge properties: `co_changes`, `step_number` | `provider.ts` | Coupling and process queries |
| CLI command `axon analyze .` | `lifecycle.ts` | Repo indexing shell-out |
| CLI command `axon host --port <N>` | `lifecycle.ts` | Host start shell-out |
| CLI command `axon --version` | `lifecycle.ts` | Availability probe |
| Binary name `axon` | `lifecycle.ts` | All three shell-outs above |
| `.axon/` directory (per-repo presence flag) | `index-repo.ts` | "already analyzed" check |
| `.axon/host.json` → `host_url` key | `stop.ts`, `index-repo.ts` | Live host detection |
| `axoniq` PyPI package name | `setup.ts` | Install target; no Horus-side rename possible |
| Config key `axon.hostUrl` | `core/config.ts` | All user configs and `--axon <url>` flag |
| Resolved field `axonHostUrl` | `core/config.ts`, every CLI command | Injected into every investigation context |

---

## Safe surfaces — rename freely

| Surface | Notes |
|---------|-------|
| Web UI text, titles, banners, colors | Horus never reads the UI |
| MCP transport (`/mcp`, tool names `axon_query` etc.) | Horus uses HTTP only — MCP unused at runtime |
| Fork Python module docstrings, CLI help text | Presentation only |
| `Source*` type aliases in `packages/connectors/src/axon/types.ts` | Added by HOR-64; backing `Axon*` types stay |
| User-facing terminal strings in CLI | Done by HOR-63; no tests assert on wording |

---

## Before merging any change to a frozen surface

Run the three contract test files in order:

```bash
# 1. HTTP API routes and response shapes
pnpm --filter @horus/connectors test -- src/axon/contract.test.ts

# 2. AxonCodeProvider behavior (Cypher queries + data mapping)
pnpm --filter @horus/connectors test -- src/axon/provider.contract.test.ts

# 3. Graph schema (node labels, rel_type values)
pnpm --filter @horus/connectors test -- src/axon/schema.contract.test.ts

# Full suite (includes all three above)
pnpm --filter @horus/connectors test
pnpm typecheck
```

All three must pass before the change is considered safe. If any fails, the frozen
surface has drifted — fix the fork or revert the connector change before merging.

---

## Config key migration prerequisite

`axon.hostUrl` and `axonHostUrl` cannot be renamed until a config migration shim exists.
Before attempting either rename:

1. Add a `sourceHostUrl` alias in `core/config.ts` alongside the existing key.
2. Write a migration that reads both and prefers the new key.
3. Add a deprecation warning when the old key is present.
4. Only then remove the old key in a follow-up.

---

## Stitcher interface debt (blocks `AxonHttpClient` rename)

`packages/stitcher/src/stitch.ts` imports `AxonHttpClient` directly. This must not
be renamed until:

1. `CodeProvider` (or a new `CypherProvider` sub-interface) gains the Cypher operations used by `stitch.ts`.
2. The stitcher is updated to accept the interface.

See `docs/source-intelligence-boundary.md §2g` for details.
