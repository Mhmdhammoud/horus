# Horus Config Path Precedence

Every Horus command needs a valid config to resolve project/environment scope,
database URL, and connector settings. When no explicit path is given, Horus
discovers the config automatically using the following precedence order.

## Resolution order (highest → lowest priority)

| Priority | Source | How it is activated |
|----------|--------|---------------------|
| 1 | **`--config <path>` flag** | Pass `-c` / `--config` to any command |
| 2 | **Project name lookup** | Pass `--name <project>` to look up the registered config path in `~/.horus/registry.json` |
| 3 | **`.horus/config.json` (local, git-style discovery)** | Walk up from the current directory until `.horus/config.json` is found — like `.git` discovery |
| 4 | **`HORUS_CONFIG` environment variable** | Set `HORUS_CONFIG=/path/to/config.js` before running |
| 5 | **`config/horus.config.js`** | Relative to the current directory; preferred for built-binary use (native `import()`, no jiti) |
| 6 | **`config/horus.config.ts`** | Relative to the current directory; source-mode fallback (requires jiti + babel) |

The first source that resolves to an existing path wins. Each source is only
tried if all higher-priority sources are absent or empty.

## Examples

### Use the project-local config (most common)

```bash
cd /repos/atlas-payments
horus investigate "checkout timeout"
# Discovers .horus/config.json walking up from cwd
```

### Override with an explicit path

```bash
horus doctor --config /etc/horus/production.config.js
```

### Use an environment variable (CI)

```bash
export HORUS_CONFIG=/ci/horus.config.js
horus investigate "deploy spike"
```

### Use a named project from anywhere

```bash
# Requires the project to be registered: horus init --name atlas-payments
horus investigate --name atlas-payments "queue backlog"
```

## File formats

| Extension | Loaded via | When to use |
|-----------|-----------|-------------|
| `.json` | JSON.parse | `.horus/config.json` (written by `horus init`; wraps a single project) |
| `.js` / `.mjs` / `.cjs` | native `import()` | Preferred for `config/horus.config.js` — works with the installed binary without extra tooling |
| `.ts` | jiti | Source-mode development only (`tsx`, `ts-node`); not recommended with the installed binary |

## Notes on the installed binary

The `curl` installer places a compiled binary that uses native `import()` to
load `.js`/`.mjs`/`.cjs` configs directly. For TypeScript configs (`.ts`),
jiti needs `babel.cjs` to be resolvable from the config file's directory
(i.e. the project must have `jiti` in its `node_modules`). If you are using
the installed binary without local `node_modules`, stick with `.js`.

See [troubleshooting.md §1](./troubleshooting.md) for symptoms and fixes when
no config is found.

## Tests

Config path precedence is tested in:
- `packages/core/src/config.test.ts` — `describe('loadConfig — path precedence (HOR-131)')`

The test suite covers: explicit path bypasses discovery; `.horus/config.json`
from cwd beats `HORUS_CONFIG`; `.horus/config.json` discovered by walking up
subdirectories; `HORUS_CONFIG` beats `config/horus.config.js`; fallback to
`config/horus.config.js`; clear error messages for missing configs.
