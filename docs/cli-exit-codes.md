# Horus CLI Exit Code Contract

Every `horus` subcommand returns a POSIX exit code via `process.exitCode`.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — the command completed normally |
| `1` | Known failure — see command table below |

Horus does not use exit codes 2–127. Any non-zero code other than 1 indicates an
unexpected crash (uncaught exception from Commander or Node.js).

## Per-command contract

### `horus init`

| Scenario | Exit |
|----------|------|
| `.horus/config.json` written and project registered | `0` |
| Target directory not writable (EACCES) | `1` |
| Any other error caught in the top-level try/catch | `1` |

`--axon <url>`, `--env <name>`, and `--name <name>` are optional — omitting them
never causes a non-zero exit.

### `horus doctor`

| Scenario | Exit |
|----------|------|
| All checks pass or warn (missing config, unreachable DB, missing connectors) | `0` |
| Any check reaches explicit `fail` status | `1` |

`doctor` currently has no `fail`-status cases — missing or unreachable services
are `warn` (exit 0). This is intentional: the command is a readiness report, not
a gate.

### `horus setup`

| Scenario | Exit |
|----------|------|
| All prerequisites present | `0` |
| Any prerequisite is absent | `1` |

### `horus generate-config`

| Scenario | Exit |
|----------|------|
| Config file written | `0` |
| Output file exists and `--force` not set | `1` |
| Write error | `1` |

### `horus investigate`

| Scenario | Exit |
|----------|------|
| Investigation completes (even with degraded evidence) | `0` |
| Config load failure | throws (propagates to Commander → `1`) |
| DB connection failure | `1` |

### `horus replay <id>`

| Scenario | Exit |
|----------|------|
| Report rendered to stdout | `0` |
| Investigation ID not found | `1` |
| Investigation found but has no stored report | `1` |
| Config load failure | throws (propagates to Commander → `1`) |

### `horus postmortem <id>`

| Scenario | Exit |
|----------|------|
| Postmortem Markdown written to stdout (or `--output` file) | `0` |
| Investigation ID not found | `1` |
| Investigation found but has no stored report | `1` |
| `--output` file already exists and `--force` not set | `1` |
| Write error when saving to `--output` | `1` |
| Config load failure or any uncaught error | `1` |

### `horus investigations`

| Scenario | Exit |
|----------|------|
| List rendered (including empty list) | `0` |
| DB connection failure | `1` |

## Testing

Exit codes are tested in `packages/cli/src/commands/exit-codes.test.ts` using
offline mocks — no live Postgres, Axon host, or runtime connectors required.

The doctor command's exit codes are tested more exhaustively in
`packages/cli/src/commands/doctor.test.ts`.

Postmortem file-write scenarios are tested in `packages/cli/src/commands/postmortem.test.ts`.
