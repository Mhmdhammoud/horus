# Axon compatibility surface (HOR-35)

> What Horus actually depends on in Axon **1.0.1**, derived from the connector code
> (`packages/connectors/src/axon/*`), not from docs. Use this as the contract when
> forking/rebranding: **keep everything in "Frozen" identical; "Free" is yours to change.**
>
> Source repo being forked: `https://github.com/harshkedia177/axon` (PyPI `axoniq`, pin `1.0.1`).

## TL;DR

Horus talks to Axon over **HTTP only**, plus the **`axon` CLI for lifecycle** (analyze/host)
and two **on-disk files**. **Horus does *not* use the MCP transport at runtime** — `/mcp`,
`axon_query`, `axon_context`, `axon_impact`, `axon_detect_changes` appear only in `docs/`,
never in connector code. So the MCP surface is *not* a hard dependency (rebrand-safe), but
the **Cypher/Kùzu graph schema is** the deepest dependency and must not move.

---

## FROZEN — do not change in the fork (Horus breaks)

### 1. HTTP routes + response shapes (`client.ts`)
| Method / Path | Used by Horus | Request | Response shape Horus parses |
|---|---|---|---|
| `GET /api/health` | ✅ 19 sites | — | `res.ok` / HTTP status (body ignored) |
| `POST /api/cypher` | ✅ 10 sites | `{ query }` | `{ columns[], rows: unknown[][], rowCount, durationMs }` — **rows are arrays aligned to RETURN order** |
| `POST /api/search` | ✅ 5 sites | `{ query, limit }` | `{ results: [{ nodeId, score, name, filePath, label, snippet }] }` |
| `GET /api/impact/:nodeId?depth=N` | ✅ 4 sites | path+query | `{ target: AxonNode, affected, depths: Record<string, AxonNode[]> }` |
| `POST /api/diff` | ✅ 1 site | `{ base, compare }` | `{ added[], removed[], modified[{before,after}], addedEdges[], removedEdges[] }` |
| `GET /openapi.json` | ✅ 2 sites (version) | — | `{ info: { version } }` — used to read/pin Axon version |

`AxonNode` shape Horus relies on: `{ id, label, name, filePath, startLine, endLine, signature, language, className, isDead, isEntryPoint, isExported }`.

### 2. Cypher / Kùzu graph schema (deepest dependency — `provider.ts`)
Horus hand-writes Cypher against this exact schema. Renaming any label, the relation
table, a property, or a `rel_type` value silently breaks investigation.

- **Node labels:** `File`, `Process`, `Community` (plus generic `(n)` matched by `n.id`)
- **Relation table:** `CodeRelation` with discriminator property **`rel_type`**, values used:
  `calls`, `uses_type`, `member_of`, `defines`, `imports`, `coupled_with`, `step_in_process`
- **Node properties read:** `id`, `name`, `file_path`, `start_line`, `end_line`,
  `signature`, `language`, `class_name`, `content`, `is_dead`
- **Edge properties read:** `co_changes`, `step_number`

### 3. CLI lifecycle (`lifecycle.ts` — shell-out is allowed here, queries are not)
- `axon --version` (availability probe)
- `axon analyze .` (run in repo root; produces the index)
- `axon host --port <N>` (detached background host; **one host per repo** — single-writer Kùzu lock)

### 4. On-disk contract
- `.axon/` directory presence ⇒ "repo is analyzed"
- `.axon/host.json` with key **`host_url`** (string) ⇒ source of truth for an already-running host

### 5. Behavioral invariants
- One host per repo; different repos → different ports, run concurrently
- `GET /api/health` returns 2xx once the host is ready (Horus polls it)
- 5xx is retryable, 4xx is not (client retry policy assumes this)

---

## FREE — safe to rebrand/change in the fork (Horus never observes it)

- UI: branding, logo, page title, colors, nav labels, copy/text, HTML
- Anything served to humans (dashboards/web UI)
- **MCP transport** (`/mcp`, `mcp_url`, tool names `axon_query`/`axon_context`/`axon_impact`/`axon_detect_changes`) — unused by Horus runtime; rename freely
- Endpoints defined in the client but with **0 call-sites**: `GET /api/host`, `GET /api/overview`, `nodeCount` — not exercised today (still, leave them if cheap, for headroom)
- Internal analyzer implementation, embedding model, log format, CLI help text/banners

---

## Fork checklist for HOR-35
1. `gh repo fork harshkedia177/axon --clone`; pin to the `1.0.1` tag/commit Horus uses.
2. Rebrand **only** the "FREE" list.
3. Run Horus's contract tests against the fork's host before swapping the pin:
   `packages/connectors/src/axon/{contract,provider.contract,schema.contract}.test.ts`.
4. If any FROZEN surface *must* change, bump the pin in `config/horus.config.ts` +
   `README.md` and update the connector in the same change.
