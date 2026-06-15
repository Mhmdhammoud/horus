# Horus First-Run Troubleshooting Guide

Use this guide when Horus produces an error, exits non-zero, or returns an investigation with no useful output on the first run. Each section lists symptoms, likely cause, and the exact command to diagnose or fix the problem.

For install-only problems (`horus: command not found`, platform/arch mismatch, download failure) see [install.md](./install.md#troubleshooting).

---

## 1. Config missing or invalid

### Symptoms

```
Error: no .horus/config.json found in this directory or any parent
Error: horus.config.ts not found or failed to load
Project "<name>" not found in registry
```

### Likely cause

`horus init` has not been run for this repository, or the config file is malformed / references a path that no longer exists.

### Fix

```sh
# Run from the repository root:
horus init

# Verify the config was created:
cat .horus/config.json

# Re-check readiness:
horus doctor
```

If you already have a config and the error is "Project not found in registry", the global registry (`~/.horus/registry.json`) is out of sync. Re-register:

```sh
horus init --name <your-project-name>
```

If the config file exists but fails to parse, validate it against the schema manually:

```sh
node -e "JSON.parse(require('fs').readFileSync('.horus/config.json','utf8')); console.log('valid')"
```

A parse error in the output points to the malformed line.

---

## 2. Database not running or migrations not applied

### Symptoms

```
error: connect ECONNREFUSED 127.0.0.1:5433
Error: relation "investigations" does not exist
NeonDbError: endpoint is disabled
```

### Likely cause

Postgres is not running, is on the wrong port, or the Drizzle migrations have not been applied to a fresh database.

### Fix

**Start Postgres:**

```sh
docker compose up -d
```

Verify it is up:

```sh
docker compose ps
```

`horus-db` (or your container name) should show `running`.

**Apply migrations:**

```sh
pnpm --filter @horus/db migrate
```

Or if running the built binary:

```sh
DATABASE_URL=postgresql://horus:horus@localhost:5433/horus node apps/horus/dist/index.cjs status
```

The `DATABASE_URL` used by Horus defaults to `postgresql://horus:horus@localhost:5433/horus`. Override it with the environment variable if your Postgres instance uses a different URL.

**Check the connection string:**

```sh
horus doctor -c horus.config.ts
```

`doctor` prints the resolved database URL so you can confirm it points at the right host/port.

---

## 3. Source-intelligence host unavailable

### Symptoms

```
Error: source-intelligence host unreachable at http://127.0.0.1:8420
horus index: source-intelligence host not responding
explain / blast-radius / architecture / search: failed to connect
```

### Likely cause

The source-intelligence backend is not running. Horus needs a live source-intelligence host for source-aware commands (`horus index`, `horus explain`, `horus blast-radius`, `horus architecture`, `horus search`). It is **not** required for runtime-only investigations.

### Fix

Start the source-intelligence host for the repository you want to investigate:

```sh
cd /path/to/your-repo
horus index   # analyzes on first run, then starts the host and stitches the queue map
```

Verify it is reachable:

```sh
curl -s http://127.0.0.1:8420/health
```

Expected: `{"status":"ok"}` or similar JSON.

The `.horus/config.json` created by `horus index` uses `source.hostUrl`. To update an existing config:

```sh
horus init --axon http://127.0.0.1:8420
# or edit .horus/config.json directly:
#   "source": { "hostUrl": "http://127.0.0.1:8420" }
```

Re-run `horus doctor` to confirm the host is now reachable.

**If you only need runtime evidence** (logs, metrics, queue state) and do not need code-level context, Horus works without the source-intelligence host. Skip this step and proceed to connector configuration.

---

## 4. No indexed repo (queue map not built)

### Symptoms

```
No queue map found for project "<name>". Run `horus index` first.
horus queues: no producer→queue→worker edges — index is empty
```

### Likely cause

`horus index` has not been run for the project, or the stitcher ran against a source-intelligence host that had not yet finished its analysis pass.

### Fix

```sh
# From anywhere — uses the registered project name:
horus index --name <your-project>

# Or from inside the repo directory:
horus index
```

`horus index` requires the source-intelligence host to be running (see §3 above). If the host is healthy but the queue map is still empty after indexing, the codebase may not use BullMQ/queue patterns that the stitcher recognises. Check with:

```sh
horus queues
```

An empty result means no `queue.add()` → `@Processor` pairs were found in the indexed source. This is expected for services without async queues — investigation still works from runtime evidence alone.

---

## 5. Installed binary startup or config problems

### Symptoms

```
horus: command not found
horus --version returns wrong version
Error: Cannot find module ...
```

For install-specific issues (PATH, platform, architecture), see [install.md](./install.md#troubleshooting).

**Config not found after binary install:**

The installed binary looks for `horus.config.ts` or `.horus/config.json` starting from the current directory. Run Horus from inside a repository that has been initialised with `horus init`, or pass the config path explicitly:

```sh
horus status -c /path/to/horus.config.ts
```

**Node.js version mismatch:**

```sh
node --version   # must be 22+
```

If Node is below 22, the CLI may fail silently or with ESM import errors. Update Node and re-run.

**Binary vs local build mismatch:**

If you are developing locally and the binary on `PATH` is a stale release, pin your shell to the local build:

```sh
alias horus="node $(pwd)/apps/horus/dist/index.cjs"
```

---

## 6. Runtime connector missing or unavailable

### Symptoms

```
Connector "elasticsearch" not configured for environment "production"
Failed to connect to Elasticsearch: ECONNREFUSED
MongoDB query failed: Authentication failed
Grafana: 401 Unauthorized
```

### Likely cause

No connector has been added for this project/environment, the connector URL is wrong, or credentials are missing from the environment.

### Fix

**Add a connector:**

```sh
horus connect elasticsearch \
  --url https://your-cluster:9200 \
  --username elastic \
  --password "$ES_PASSWORD" \
  --index-pattern "your-service-prod-*"

horus connect mongodb \
  --url "mongodb://user:pass@host:27017" \
  --database your_db \
  --collections "orders,payments"

horus connect grafana \
  --url https://grafana.your-org.com \
  --username admin \
  --password "$GRAFANA_PASSWORD"
```

**Verify all connectors:**

```sh
horus status
```

`horus status` prints a per-project/environment health matrix. A `✓` means the connector is reachable; `✗` includes the error.

**Credentials not loading:**

Connector credentials are resolved from environment variables at runtime. If a connector is configured with `$ENV_VAR` references, ensure the variables are set before running:

```sh
source ~/.horus.env   # or whichever file you keep credentials in
horus status
```

**Connector works but returns no data:**

Check that the index pattern, database name, or collection allowlist matches what exists in your actual system:

```sh
horus logs --env production            # raw log count from Elasticsearch
horus state --env production           # MongoDB collection summary
horus metrics --env production         # Grafana panel discovery
```

If a command exits 0 but prints nothing, the connector is reachable but the query found no matching data (wrong index pattern, wrong time window, etc.).

---

## 7. Low confidence: what evidence is missing

### Symptoms

```
Confidence: 18%
Gap analysis: metrics connector not configured
Gap analysis: no runtime log evidence found
Gap analysis: source-intelligence host unavailable
```

### Likely cause

Horus confidence is proportional to the evidence it can collect. A single connector (e.g. git only) produces a low-confidence report. Each connector you add raises the ceiling.

### Understanding the gap analysis

Every investigation report ends with a gap analysis section. Read it directly:

```sh
horus investigate --project <p> --env <e> "your incident hint"
```

The output includes:

```
Gap analysis
  metrics    — No metrics connector configured. Add Grafana for latency/error-rate trends.
  logs       — No Elasticsearch connector. Log evidence unavailable.
  ...
Confidence ceiling: 35%
```

Each gap names the dimension that is blind and the connector that would fill it.

### Fix by dimension

| Missing dimension | Connector to add |
|---|---|
| Logs / error signatures | Elasticsearch (`horus connect elasticsearch`) |
| Application state | MongoDB (`horus connect mongodb`) |
| Metrics / latency trends | Grafana (`horus connect grafana`) |
| Queue backlog / worker starvation | Redis/BullMQ (configured via `horus connect redis`) |
| Code changes / owner signals | source-intelligence host (see §3) |

After adding a connector, re-run the investigation:

```sh
horus investigate --project <p> --env <e> "your incident hint"
```

Confidence rises as each blind spot is filled.

**If confidence is low despite all connectors being configured:**

The evidence may genuinely be sparse — the incident window may not overlap with the collection window. Try adjusting the time range:

```sh
horus investigate --since HEAD~20 "your incident hint"
```

Or replay an earlier investigation to compare:

```sh
horus investigations          # list saved investigations
horus replay <id>             # re-render a saved report
```

---

## Quick diagnostic checklist

Run these in order when Horus produces unexpected output:

```sh
horus doctor                  # overall readiness
horus status                  # connector health matrix
horus investigations          # confirm the audit store is reachable
horus investigate "test" 2>&1 | tail -30  # last 30 lines of output + error
```

Still stuck? Check `docs/connector-setup.md` for connector-by-connector setup walkthroughs and `docs/install.md` for binary installation issues.
