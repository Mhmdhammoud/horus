# source-py — vendored horus-source (HOR-450, step A)

This directory is the **horus-source** Python backend (tree-sitter source intelligence:
FastAPI host, SQLite+sqlite-vec+FTS5, local embeddings), vendored into the monorepo so
the CLI and the backend live in **one repo** — atomic cross-boundary changes, one issue
tracker, one CI, and the end of the version-drift surface that the HOR-436 version-pin
guard exists to manage.

## What this is (step A) vs. what's deferred (step B)

This PR does **step A only** — the monorepo move:

- The Python tree is vendored here (`src/`, `tests/`, `pyproject.toml`, `uv.lock`).
- Its test suite runs in CI as a dedicated `source-py` job (uv + pytest).
- It is **additive and reversible** — nothing in the existing TS packages changes, and
  the standalone `horus-source` repo is untouched. Nothing is released.

**Deferred to step B** (a separate, release-touching change — intentionally NOT done here
because it reshapes the release pipeline and can't be validated without releasing):

- Build a self-contained horus-source binary (PyInstaller/pex) per platform and publish
  it as a GitHub Release asset.
- Point `install.sh` / the npm postinstall at the bundled binary and drop the user-facing
  PyPI install path.
- Single version + single changelog; retire the paired-version dance + the HOR-436 pin guard.

## Working in here

```bash
cd packages/source-py
uv sync --extra dev
uv run --extra dev pytest tests/ -q
```

Source of truth until step B lands: the standalone `Meritt-dev/horus-source` repo. Keep
this copy in sync there until the cutover.
