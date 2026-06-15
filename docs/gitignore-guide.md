# Horus — What to Commit and What to Gitignore

Horus writes files in two places: inside your project repo and in your home directory.
Only files inside your repo are governed by `.gitignore`.

## Quick reference

| File | Commit? | Reason |
|------|---------|--------|
| `.horus/config.json` | **Yes — commit it** | Project config (name, env, Axon host URL). No secrets. |
| `horus.config.js` | **Yes — commit it** | Full multi-project config. No secrets — credentials come from environment variables at runtime. |
| `.horus.env` or any local credential file | **Never — gitignore it** | Contains connector credentials. Must not be committed. |
| `~/.horus/registry.json` | N/A — home directory | Global project name index; outside your repo. |

## Recommended `.gitignore` entries

Add these to your project's `.gitignore`:

```gitignore
# Horus — local credential files (never commit secrets)
.horus.env
*.horus.env
```

You do **not** need to gitignore `.horus/` itself — committing it lets teammates use the same
project scope without re-running `horus init`.

If you intentionally keep `.horus/config.json` out of source control (e.g. the config
contains local machine paths that differ per developer), add:

```gitignore
# Horus — per-developer local config (add only if you do not want to share it)
.horus/
```

## Why `.horus/config.json` is safe to commit

`horus init` writes a config that contains:

- Project name and repo path
- Environment name (`production`, `staging`, etc.)
- Axon host URL (a localhost address — no credentials)

It does **not** write connector passwords, API keys, or any other secrets.
Connector credentials are always read from environment variables at runtime,
never stored in `.horus/config.json`.

## Where secrets live

Credentials are read from environment variables. A common pattern is a local file
sourced before running Horus:

```sh
# ~/.horus.env  (home directory — never inside a project repo)
export DATABASE_URL=postgresql://horus:horus@localhost:5433/horus
export ES_USERNAME=my-user
export ES_PASSWORD=my-password
```

Source it before investigating:

```sh
source ~/.horus.env
horus investigate "checkout latency spike"
```

Keep this file in `~/` — not in your project repo.

## What Horus does NOT touch

- **`.gitignore`** — Horus never writes or modifies your `.gitignore`
- **Production systems** — Horus is read-only against all runtime connectors

## See also

- [Install guide](./install.md) — what gets installed and where
- [Config path precedence](./config-path-precedence.md) — how Horus discovers its config
