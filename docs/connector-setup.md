# First-run connector setup

This document walks you through the steps to connect Horus to runtime evidence
providers after installation. Each section is honest about what Horus can do
without a given connector and what you gain by configuring it.

---

## Install

```sh
curl -fsSL https://horus.sh/install.sh | bash
```

Verify the install:

```sh
horus --version
horus --help
```

The installer does **not** connect Horus to any production system. All connector
configuration happens explicitly, in your repository.

---

## Readiness check

Before configuring connectors, run the built-in readiness check:

```sh
horus doctor
```

`horus doctor` verifies:
- CLI version
- Git repository detection
- Presence of a `.horus/config.json` local config
- Source-intelligence host reachability (if configured)

If any check fails, the output includes the specific fix. Exit code 0 means all
checks passed; non-zero means at least one check failed.

---

## Initialise a project

Run `horus init` once per repository to create a `.horus/config.json` and
register the project in the global registry (`~/.horus/registry.json`):

```sh
cd /path/to/your/repo
horus init --name my-service --env production
```

Options:

| Flag | Purpose |
|------|---------|
| `--name <name>` | Project name (default: git root directory name) |
| `--env <name>` | Environment name (default: production) |
| `--axon <url>` | Source-intelligence host URL (e.g. `http://127.0.0.1:8420`) |
| `--path <dir>` | Repository root (default: nearest git root) |

After `horus init`, the local config lives at `.horus/config.json`. Horus
discovers it automatically when you run commands from inside the repo.

---

## Source intelligence (no runtime connectors required)

Horus can investigate incidents using **source intelligence alone**:

- Symbol lookup and impact analysis
- Queue-boundary tracing
- Git change attribution
- Ownership estimation

Source intelligence comes from Axon, the indexing backend. Point your config at
a running Axon host with `--axon`:

```sh
horus init --name my-service --env production --axon http://127.0.0.1:8420
```

To build the queue map (run the stitcher against the source-intelligence host):

```sh
horus index
```

To verify the repositories and host health:

```sh
horus repos
```

Runtime evidence (logs, metrics, state, queue snapshots) is **optional**. If
no runtime connectors are configured, Horus will report evidence gaps but will
still produce a deterministic investigation based on source context alone.

---

## Connect runtime evidence providers

Use `horus connect <type>` to add or update a connector in `.horus/config.json`.
Each connector type is described below. All connectors are **opt-in**; skip the
ones you do not use.

### Elasticsearch (logs)

```sh
horus connect elasticsearch \
  --url https://your-es-host:9200 \
  --username elastic \
  --password YOUR_PASSWORD \
  --index-pattern "my-service-*" \
  --service my-service-prod
```

| Flag | Purpose |
|------|---------|
| `--url <url>` | Elasticsearch base URL |
| `--username <user>` | Username for authentication |
| `--password <pass>` | Password for authentication |
| `--index-pattern <pattern>` | Index pattern (e.g. `my-service-*`) — required |
| `--service <name>` | Service name scope for log queries — optional |
| `--no-test` | Skip the live connection probe |

**Do not put real credentials in the config file.** Use environment variable
indirection instead:

```json
{
  "connectors": {
    "elasticsearch": {
      "indexPattern": "my-service-*",
      "serviceName": "my-service-prod",
      "urlEnv": "ES_URL",
      "usernameEnv": "ES_USERNAME",
      "passwordEnv": "ES_PASSWORD"
    }
  }
}
```

Horus reads `ES_URL`, `ES_USERNAME`, and `ES_PASSWORD` from the environment at
runtime. The defaults are those exact variable names, so you only need `urlEnv`
etc. if you use non-default names.

**Field mapping:** By default Horus uses the `meritt` preset (pino-based,
numeric level, `time` timestamp field). For ECS-shaped indices use `preset: "ecs"`.
For a custom shape, see [docs/elasticsearch-field-mapping.md](./elasticsearch-field-mapping.md).

**What you gain:** Horus can pull log error signatures, trace correlations, and
event code clusters from Elasticsearch and surface them as evidence in `horus investigate`.

**Without this connector:** Investigations show a gap in the `logs` dimension.
Confidence ceiling is reduced. No log evidence appears in the report.

---

### MongoDB (application state)

```sh
horus connect mongodb \
  --url "mongodb://user:pass@host:27017/mydb" \
  --database mydb \
  --collections "orders,payments,users"
```

| Flag | Purpose |
|------|---------|
| `--url <url>` | MongoDB connection string |
| `--database <name>` | Database name — required |
| `--collections <list>` | Comma-separated allowlist of collection names |

Use environment variable indirection to keep credentials out of the config:

```json
{
  "connectors": {
    "mongodb": {
      "database": "mydb",
      "collections": ["orders", "payments", "users"],
      "urlEnv": "MONGODB_URL"
    }
  }
}
```

**What you gain:** Horus reads document counts, staleness, and anomalous status
distributions from the allowlisted collections. This surfaces application-state
evidence alongside log and metric evidence.

**Without this connector:** No state evidence appears. Investigations that
involve suspected data-layer anomalies will show a gap in the `state` dimension.

---

### Grafana (metrics)

```sh
horus connect grafana \
  --url https://your-grafana-host:3000 \
  --username admin \
  --password YOUR_PASSWORD \
  --dashboard your-dashboard-uid
```

| Flag | Purpose |
|------|---------|
| `--url <url>` | Grafana base URL |
| `--username <user>` | Username for authentication |
| `--password <pass>` | Password (or API token in the password field) |
| `--dashboard <uid>` | Default dashboard UID to restrict metric queries |

Use environment variable indirection:

```json
{
  "connectors": {
    "grafana": {
      "dashboard": "your-dashboard-uid",
      "urlEnv": "GRAFANA_URL",
      "usernameEnv": "GRAFANA_USER",
      "passwordEnv": "GRAFANA_PASSWORD"
    }
  }
}
```

**What you gain:** Horus detects latency spikes, error-rate changes, and
throughput drops from Grafana panels. Metric evidence is correlated with log
and queue evidence in the investigation timeline.

**Without this connector:** No metric evidence appears. Investigations involving
suspected performance regressions will show a gap in the `metrics` dimension.

---

### Redis / BullMQ (queue state)

```sh
horus connect redis --url redis://localhost:6379
```

Use environment variable indirection:

```json
{
  "connectors": {
    "redis": {
      "urlEnv": "REDIS_URL"
    }
  }
}
```

**What you gain:** Horus reads BullMQ queue states from Redis (waiting,
active, delayed, failed counts) and surfaces queue-state evidence. This is
especially useful for diagnosing job-processing incidents.

**Without this connector:** No queue-state evidence appears. Queue-topology
edges from source intelligence (structural) still appear, but operational
queue health signals are absent.

---

## Verify connector setup

After running `horus connect`, verify the active configuration:

```sh
horus setup
```

`horus setup` checks prerequisites and reports the health of each configured
connector. Use `horus status` for a more compact environment matrix view:

```sh
horus status
```

---

## Run an investigation

With connectors configured:

```sh
horus investigate "payment processing failures"
```

Scope to a specific project and environment when you have multiple:

```sh
horus investigate "payment processing failures" \
  --project my-service \
  --env production
```

The investigation report includes a `sourceStatus` section that shows which
evidence sources contributed, which were configured but returned no evidence
(empty), and which were not configured at all. This makes evidence gaps
explicit rather than silent.

---

## Understanding evidence gaps

When a connector is not configured, or when a configured connector collected no
evidence, Horus reports a gap analysis:

- **not-configured**: the connector was not set up for this environment.
- **empty**: the connector ran but found no matching evidence (the time window
  may be too narrow, or the service filter may be too strict).
- **failed**: the connector was configured but collection failed (wrong field
  mapping, unreachable host, or bad credentials).
- **contributed**: the connector ran and provided evidence items.

Gaps reduce the investigation's confidence ceiling. A low confidence score does
**not** mean Horus is broken — it means the report is working correctly with the
evidence that was available.

To close a gap, configure the missing connector with `horus connect <type>` and
re-run the investigation.

---

## Example `.horus/config.json`

A complete local config for a single project with all connectors using
environment variables:

```json
{
  "project": {
    "name": "my-service",
    "repositories": [
      {
        "name": "my-service",
        "path": "/path/to/my-service",
        "axon": {
          "hostUrl": "http://127.0.0.1:8420"
        }
      }
    ],
    "environments": [
      {
        "name": "production",
        "readOnly": true,
        "connectors": {
          "elasticsearch": {
            "indexPattern": "my-service-*",
            "serviceName": "my-service-prod",
            "preset": "meritt",
            "urlEnv": "ES_URL",
            "usernameEnv": "ES_USERNAME",
            "passwordEnv": "ES_PASSWORD"
          },
          "mongodb": {
            "database": "mydb",
            "collections": ["orders", "payments"],
            "urlEnv": "MONGODB_URL"
          },
          "grafana": {
            "dashboard": "your-dashboard-uid",
            "urlEnv": "GRAFANA_URL",
            "usernameEnv": "GRAFANA_USER",
            "passwordEnv": "GRAFANA_PASSWORD"
          },
          "redis": {
            "urlEnv": "REDIS_URL"
          }
        }
      }
    ]
  }
}
```

---

## Troubleshooting

### "no .horus/config.json found"

Run `horus init` in your repository root. The `.horus/` directory and
`config.json` are created automatically.

### "Unknown project" when running horus investigate

The project is not in the global registry. Run `horus index --name my-service`
from inside the repo, or verify registration with `horus projects`.

### Connector shows "failed" in investigation

Check the connector URL and credentials. For Elasticsearch, verify the index
pattern, timestamp field, and `levelFormat` setting match your actual index
mapping. See [docs/elasticsearch-field-mapping.md](./elasticsearch-field-mapping.md)
for the full failure-mode reference.

### Confidence is low even with connectors configured

Low confidence with connectors means the evidence is sparse, not that setup is
wrong. Narrow or widen the investigation hint, check the service name filter, or
extend the time window with `--since`.

### Source-intelligence host is unreachable

Check that the Axon process is running on the URL in your config:

```sh
horus hosts
horus doctor
```

Source intelligence is optional at runtime: investigations proceed with whatever
evidence is available. Reachability issues reduce the quality of symbol-level
findings but do not block log/metric/state investigation.
