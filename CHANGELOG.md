# Changelog

All notable changes to the Horus CLI (`@merittdev/horus`) and its paired horus-source backend.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.12.2] — 2026-06-28 · horus-source 2.0.1

- Improved investigation accuracy: seed ranking now weights semantic similarity above raw keyword matching, so investigations surface real core code instead of same-named example/test/demo symbols. (HOR-430)

## [0.12.1] — 2026-06-28

- Fixed: `horus stop` reliably stops its own source host even after an automatic port fallback.
- Docs: README refreshed.

## [0.12.0] — 2026-06-28 · horus-source 2.0.0

- Storage engine rewrite: source-intelligence storage migrated from KuzuDB to SQLite + sqlite-vec (+ FTS5). Lighter install, EOL KuzuDB dependency retired, re-index automatic on upgrade. KuzuDB stays opt-in for one release via `HORUS_SOURCE_STORAGE_BACKEND=kuzu` + the `[kuzu]` extra. (Major: horus-source 2.0.0.)

## [0.11.0] — 2026-06-28

- Axiom connector: `horus connect axiom` (token, region, live dataset pick); Axiom logs flow into investigations as evidence with provenance.

## [0.10.0] — 2026-06-28 · horus-source 1.6.1

- Quality + knowledge graph: interactive Knowledge Graph (Explore + Timeline), Evidence-v2 (subject + typed findings), per-investigation Provenance view, per-tenant accuracy / Insights, and the memory-to-memory link graph (supersedes / contradicts / recurs-with). Plus a large batch of investigation-quality fixes from dogfooding on 50+ real repositories.

## [0.9.0] — 2026-06-28

- Memory + dashboard: the memory system (capture / recall / confirm), the eval/outcome store, self-routing investigations, and the cloud dashboard.

## [0.8.x] — 2026-06-24 to 2026-06-27

- Hardening: dogfood-driven fixes and connector hardening across many real repositories.

## [0.1.0–0.7.0] — 2026-06-17 to 2026-06-23

- Initial development: the core investigation engine, source intelligence, the first connectors, and the CLI foundations.
