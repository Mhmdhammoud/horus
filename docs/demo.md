# Horus local demo (HOR-88)

Copy-pasteable commands for a live local demo.
Every step is real — no staging, no mocked output.

---

## Prerequisites

| Requirement | Why |
|-------------|-----|
| Node.js 22+ | the Horus binary is a Node executable |
| Docker (or Postgres 16 running on port 5433) | stores investigations, replay, postmortem |
| Python 3.11+ with `pip` or `uv` | installs the Horus source-intelligence backend |
| A git repo to index | needed for source-intelligence evidence |

---

## 1. Install Horus

```bash
# Public install (curl path — installs the binary to /usr/local/bin or ~/.local/bin):
curl -fsSL https://horus.sh/install.sh | bash
horus --version   # → horus 0.1.0

# OR run from a local build (equivalent):
node apps/horus/dist/index.cjs --version
```

The curl-installed binary loads `horus.config.js` natively (no TypeScript tooling needed).
Source-mode (`tsx apps/horus/src/index.ts`) is an alternative for development but is not required.

---

## 2. Start Postgres

```bash
# If you don't have Postgres 16 running on port 5433:
docker run -d \
  --name horus-db \
  -p 5433:5432 \
  -e POSTGRES_USER=horus \
  -e POSTGRES_PASSWORD=horus \
  -e POSTGRES_DB=horus \
  postgres:16-alpine

# Run migrations (first time only, and after pulling new versions):
pnpm --filter @horus/db migrate
```

Expected output from migrations:

```
Applying migration 0000_redundant_kabuki.sql
Applying migration 0001_flaky_lester.sql
...
Migrations applied
```

---

## 3. Write a config file

Create `config/horus.config.js` at the repo root (or copy the existing template):

```javascript
export default {
  database: {
    url: process.env.DATABASE_URL ?? 'postgresql://horus:horus@localhost:5433/horus',
  },
  projects: [{
    name: 'my-api',
    repositories: [{
      name: 'my-api',
      path: '/path/to/my-api',           // absolute path to your git repo
      source: { hostUrl: 'http://127.0.0.1:8420' },
    }],
    environments: [{
      name: 'production',
      readOnly: true,
      connectors: {
        // Add elasticsearch, mongodb, grafana here when available (see docs/connector-setup.md)
      },
    }],
  }],
};
```

**Verify config loads:**

```bash
horus doctor --config config/horus.config.js
```

Expected output:

```
Horus readiness check

  ✓ CLI version                 horus 0.1.0
  ✓ Git root                    /path/to/my-api
  ~ Local config                .horus/config.json not found
    → run `horus init` to create one for this repo
```

---

## 4. Run setup (verify all prerequisites)

```bash
horus setup --config config/horus.config.js
```

Expected output (with Postgres running and source-intelligence backend installed):

```
Horus setup

  ✓ Horus source-intelligence backend (1.0.1)
  ✓ Postgres reachable (9 tables present)
  ~ my-api — host not reachable at http://127.0.0.1:8420
    → start it with: horus index (in /path/to/my-api)

Ready.
```

If the source-intelligence backend is not installed:

```bash
# Install via pip (or uv):
pip install axoniq==1.0.1
# OR:
uv pip install axoniq==1.0.1
```

---

## 5. Start the source-intelligence host

Run this **inside your git repo** (not the Horus repo):

```bash
cd /path/to/my-api

# Start the source-intelligence host (analyzes on first run, then starts the host):
horus index
```

Then verify it indexed correctly:

```bash
horus setup --config config/horus.config.js
# → ✓ my-api — N nodes indexed (http://127.0.0.1:8420)
```

---

## 6. Run the stitcher

`horus index` from step 5 already analyzed, started the host, stitched the queue map, and registered the project. To refresh the queue map after code changes:

```bash
# From inside your repo — refreshes the queue map:
cd /path/to/my-api
horus index --name my-api --config /path/to/horus/config/horus.config.js
```

Expected output:

```
Indexing my-api / production...
Queue edges written: N edges
```

---

## 7. Run an investigation

```bash
horus investigate "workers are failing" \
  --project my-api \
  --config config/horus.config.js
```

**Expected output shape** (exact content varies by evidence):

```
Investigation: workers are failing
Project: my-api / production
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Summary
  Source-intelligence evidence from 2550 nodes.
  Confidence: 0.65 (source-only — no runtime connector evidence)
  ...

Hypotheses
  1. [high] Queue starvation — workers present, 0 messages processing
  ...

Evidence
  - Source: N queue edges found
  - Git: N recent commits to worker files
  ...
```

> **Confidence caveat:** Without runtime connectors (Elasticsearch, MongoDB, Grafana),
> confidence is capped at 0.65 (source-only). Runtime connectors raise it to 0.85–0.95
> with corroborating log and metric evidence. See `docs/connector-setup.md`.

---

## 8. List investigations and replay

```bash
# List saved investigations:
horus investigations --config config/horus.config.js

# Replay from saved audit record (no re-query):
horus replay <id> --config config/horus.config.js

# Output as markdown (for pasting into Slack/Notion):
horus replay <id> --format markdown --config config/horus.config.js
```

---

## 9. Draft a postmortem

```bash
horus postmortem <id> --config config/horus.config.js
```

Outputs a structured markdown postmortem you can edit and share. The postmortem reads from
the saved audit record — no re-query, no live connections required.

---

## 10. Status and hosts

```bash
# Full status: config, DB, source-intelligence, connector health:
horus status --config config/horus.config.js

# List all running source-intelligence hosts:
horus hosts
```

---

## What works today (verified)

| Feature | Works | Requires |
|---------|-------|----------|
| `horus --version` / `--help` | ✓ | nothing |
| `horus doctor` | ✓ | nothing |
| `horus setup` | ✓ | Postgres + Python/source-intelligence backend |
| `horus status` | ✓ | Postgres + config |
| `horus index` | ✓ | Postgres + source-intelligence backend |
| `horus investigate` | ✓ | Postgres + source-intelligence backend (source-only confidence) |
| `horus investigations` / `replay` | ✓ | Postgres (reads saved record) |
| `horus postmortem` | ✓ | Postgres (reads saved record) |
| `horus explain` / `changes` / `architecture` | ✓ | source-intelligence backend running |
| `horus logs` | ✓ | Elasticsearch (`ES_URL` env var) |
| `horus metrics` | ✓ | Grafana (`GRAFANA_URL` env var) |
| `horus state` | ✓ | MongoDB (`MONGODB_URL` env var) |
| Confidence above 0.65 | requires runtime connectors configured |

---

## What NOT to claim in a demo

- **"Horus detected the incident automatically"** — Horus responds to a hint you provide.
- **"Full confidence, all evidence"** — if runtime connectors are absent, confidence is source-only (0.65).
- **"Works out of the box after curl install"** — Postgres must be started first; run `horus index` in your repo for source intelligence.
- **"Runtime logs/metrics show X"** — only if `ES_URL`/`GRAFANA_URL` are set and the connectors have live data.
- **"Horus indexes your code automatically"** — run `horus index` in your repo to start and index it.

---

## Gaps and follow-up tickets

| Gap | Ticket |
|-----|--------|
| Confidence caveat not yet shown in investigation output | HOR-89 |
| Runtime connector setup (Elasticsearch, MongoDB, Grafana) | see `docs/connector-setup.md` |
| Cloud install improvements | HOR-87 (done — acceptance script added) |
| Config migration for source-intelligence naming | HOR-80, HOR-81 (done — checklists added) |
