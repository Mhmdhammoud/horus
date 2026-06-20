# Optional cloud sync for knowledge snapshots (HOR-296)

The Horus CLI owns the local project-knowledge index (`.horus/index/`). Horus
Cloud is an **optional** place to store and share those snapshots across a team —
it never owns or gates indexing.

```
CLI creates knowledge      (horus index)         — local, offline
CLI queries knowledge       (horus knowledge …)  — local, offline
Cloud optionally stores it  (horus knowledge push/pull) — opt-in, authenticated
```

`horus index` and `horus knowledge ask/search/...` work fully offline and
unauthenticated. Cloud sync is additive and gated.

## Commands

```bash
horus knowledge push            # upload the local snapshot to the linked cloud project
horus knowledge pull            # download the latest cloud snapshot into .horus/index/
horus knowledge status --cloud  # compare local vs cloud (hash + commit + freshness)
```

All three require: (a) authenticated mode (`horus login` → `~/.horus/auth.json`)
and (b) a cloud-linked repo (`horus context use <org>/<workspace>/<project>` →
`.horus/cloud.json`). Missing either prints a clear message and no-ops; nothing
local is touched.

## What is synced (and the redaction stance)

The snapshot is **derived, structured project knowledge** — it does NOT contain
source-file bodies. It carries:

- repository profiles (frameworks, languages, roles)
- API contracts: operation names, argument/field **types**, enum **values**
- domain concepts / business-rule summaries
- frontend pattern names + file paths
- provenance per item: **file path, line range, git sha, content hash**

So a push uploads names, type signatures, enum values, prose summaries, and file
**paths** — not the code itself. Still, these can be sensitive (internal domain
language, private file structure). Controls for v1:

- **Default = upload the full structured snapshot** to the linked project. It is
  metadata, not source, and the team already shares the repo.
- **Two redaction controls are implemented** and applied in `runKnowledgePush`
  before the snapshot leaves the machine. Configure them in `.horus/config.json`:

  ```json
  {
    "knowledge": {
      "redact": {
        "dropProvenancePaths": true,
        "summariesOnly": false
      }
    }
  }
  ```

  - `dropProvenancePaths` — strips `provenance.filePath` and `provenance.lineRange`
    from every item before upload (shares *what* exists, not *where*).
  - `summariesOnly` — additionally strips descriptive text bodies (`summary`,
    `details`, `description`, `notes`) and detail lists (`args`, `fields`, `steps`,
    `auth`, etc.) — only structural names, kinds, and provenance are uploaded.

- **No secrets are ever in a snapshot** — the index is built from code structure,
  never from `.env`/secrets, and CLI auth tokens live in `~/.horus/auth.json`
  (never in the repo or the snapshot).

## Hierarchy mapping

A snapshot is tied to a **Project** — which, post-HOR-280, **is** the
repository/codebase. The cloud key is `projectId` from `.horus/cloud.json`. (A
project belongs to a workspace + organization, so cloud-side tenancy/access is
inherited from the project.)

## Content-hash dedup + freshness

The local manifest already records a sha256 **content hash** of the canonical
snapshot (`manifest.files["knowledge-base.json"].contentHash`) and the source
**git sha** (`manifest.git.sha`).

- `push` first reads the cloud's latest snapshot hash; if it equals the local
  hash, it **skips** (no duplicate upload). Otherwise it uploads with the content
  hash as the idempotency key, so retries never create duplicates.
- The cloud stores `(projectId, contentHash, gitSha, generatedAt, counts)` so
  records show **freshness and source commit**; pushing a new hash **archives**
  the previous snapshot (server-side).
- `pull` writes the cloud snapshot into `.horus/index/` only when it differs from
  local (and refuses to clobber a differing local index without `--force`).

## Cloud API contract (the paired backend follow-up)

This ticket ships the **CLI client + commands + this design**. The Horus Cloud
ingest endpoint is the paired backend task; it must provide:

```
POST /v1/projects/:projectId/knowledge-snapshots
  body: { schemaVersion, contentHash, gitSha?, branch?, generatedAt, counts?, snapshot, manifest, idempotencyKey? }
  → KnowledgeSnapshotRecord   (dedups on contentHash; archives the prior snapshot)

GET  /v1/projects/:projectId/knowledge-snapshots/latest
  → KnowledgeSnapshotRecord   (the current non-archived snapshot, with body)
```

Storage: a `knowledge_snapshots` table scoped to org/workspace/project, with
`schema_version`, `content_hash` (unique per project), `git_sha`, `generated_at`,
`counts` (jsonb), `snapshot`/`manifest` (jsonb), `archived` (bool), `created_at`.
Auth: org membership (any member may read; owner/admin may push) — matching the
rest of `/v1`. Cross-tenant access returns 404.

Until that endpoint exists, `horus knowledge push/pull` are wired and gated
correctly but will report the cloud error from the missing route.
