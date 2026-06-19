# Horus CLI ↔ Horus Cloud: API sync, not database switching

**Locked architecture rule.** The Horus CLI talks to Horus Cloud **only through
the REST/OpenAPI `/v1` API**. "Team mode" / "cloud mode" is **API sync** — it is
**not** repointing the CLI's `DATABASE_URL` at the Cloud Postgres database.

```
Horus CLI DB    = local executor state + local investigation workspace
Horus Cloud DB  = shared team source of truth (tenancy, auth, cloud records, dashboard)
CLI → Cloud     = REST/OpenAPI only (never a direct DB connection)
```

> **The CLI never connects directly to Horus Cloud Postgres.** There is no
> supported configuration in which the CLI reads or writes the Cloud database.

## Two separate databases

| | Horus CLI database (this repo) | Horus Cloud database (`horus-cloud`) |
|---|---|---|
| Docker container | `horus-postgres` | `horus-cloud-db` |
| Host port | **5433** | **5434** |
| Database name | `horus` | `horus_cloud` |
| Env var | `DATABASE_URL` | `HORUS_CLOUD_DATABASE_URL` |
| Default URL | `postgresql://horus:horus@localhost:5433/horus` | `postgres://horus:horus_dev_password@localhost:5434/horus_cloud` |

The variables are deliberately named differently so the two systems can never
accidentally share a connection string. The CLI uses `DATABASE_URL`; it has **no**
variable that points at the Cloud database, by design.

## What each side owns

- **CLI database** — local execution-engine state: local investigations,
  evidence, findings, hypotheses, queue/traversal edges, provider cache, incident
  memory, local repo discovery/indexing. Works fully offline, with no cloud
  account.
- **Cloud database** — the shared team source of truth: users, organizations,
  workspaces, projects, memberships, invitations, CLI tokens, cloud
  investigations, cloud evidence, cloud agent runs, audit events.

Pointing the CLI's `DATABASE_URL` at the Cloud database would bypass the
`/v1` authorization boundary, mix local engine internals with team tenancy data,
break offline mode, and risk corrupting shared team data from local CLI bugs.
**Don't do it.**

## Cloud context cache: `.horus/cloud.json`

Binding a repo to a cloud project writes `<repo>/.horus/cloud.json`. It stores
**only** cloud context IDs and slugs (org/workspace/project), **carries no
secrets**, and is safe to commit. It is **convenience/cache state, not an
authorization boundary**: the Cloud API independently re-checks the authenticated
user's access on every sync and write, so a stale or edited `cloud.json` never
grants access the server wouldn't already allow.

## Team-mode flow

```bash
horus login                                        # authenticate the CLI to Cloud
horus context use <org>/<workspace>/<project>      # bind this repo's cloud context
horus cloud sync                                    # push local results to Cloud over /v1
```

`horus context list` shows available cloud projects plus the `local` context
(this CLI's own `~/.horus` local Postgres). Switching context only changes which
Cloud project `horus cloud sync` targets — it never changes which database the
CLI engine itself uses.

## See also

The Cloud repo (`horus-cloud`) holds the canonical version of this decision and
the full ownership tables in `docs/architecture/cloud-vs-cli-databases.md` and
`STRUCTURE.md`.
