from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from horus_source.core.embeddings.embedder import _DEFAULT_MODEL, EMBEDDING_SCHEME_VERSION
from horus_source.core.ingestion.watcher import ensure_current_embeddings


def test_needs_reembed_model_mismatch() -> None:
    meta = {"embedding_model": "BAAI/bge-small-en-v1.5"}
    assert meta.get("embedding_model") != _DEFAULT_MODEL


def test_needs_reembed_missing_key() -> None:
    meta = {"version": "1.0.0", "stats": {}}
    assert meta.get("embedding_model") is None


def test_no_reembed_when_matching() -> None:
    meta = {"embedding_model": _DEFAULT_MODEL}
    assert meta.get("embedding_model") == _DEFAULT_MODEL


def test_ensure_current_embeddings_reembeds_when_incomplete(tmp_path) -> None:
    # HOR-375: model + scheme are CURRENT, but the index was left with embeddings:0 (an
    # interrupted background embed). Must re-embed to restore semantic search + mark complete.
    source_dir = tmp_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(
        json.dumps({
            "embedding_model": _DEFAULT_MODEL,
            "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
            "embeddings_complete": False,
            "stats": {"symbols": 100, "embeddings": 0},
        }) + "\n",
        encoding="utf-8",
    )
    storage = MagicMock()
    storage.load_graph.return_value = object()
    with patch("horus_source.core.ingestion.watcher.embed_graph", return_value={"n1": [0.1]}):
        migrated = ensure_current_embeddings(storage, tmp_path)

    assert migrated is True
    storage.store_embeddings.assert_called_once()
    updated = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated["embeddings_complete"] is True
    assert updated["stats"]["embeddings"] == 1


def test_ensure_current_embeddings_zero_with_symbols_does_not_mark_complete(tmp_path) -> None:
    # HOR-433: meta records symbols but re-embedding yields 0 vectors (e.g. a kùzu-era
    # store whose symbols never reached the active SQLite store). Must NOT mark complete,
    # must flag a re-analyze, and must report failure — never serve a 0-embedding index
    # as "complete".
    source_dir = tmp_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(
        json.dumps({
            "embedding_model": _DEFAULT_MODEL,
            "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
            "embeddings_complete": False,
            "stats": {"symbols": 100, "embeddings": 0},
        }) + "\n",
        encoding="utf-8",
    )
    storage = MagicMock()
    storage.load_graph.return_value = object()
    with patch("horus_source.core.ingestion.watcher.embed_graph", return_value={}):
        result = ensure_current_embeddings(storage, tmp_path)

    assert result is False
    storage.store_embeddings.assert_not_called()
    updated = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated["embeddings_complete"] is False
    assert updated.get("needs_reanalyze") is True
    assert updated["stats"]["embeddings"] == 0


def test_ensure_current_embeddings_empty_repo_marks_complete(tmp_path) -> None:
    # An empty repo legitimately has 0 symbols and 0 embeddings — the 0-embedding guard
    # must NOT misfire there; marking complete is correct.
    source_dir = tmp_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(
        json.dumps({
            "embedding_model": _DEFAULT_MODEL,
            "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
            "embeddings_complete": False,
            "stats": {"symbols": 0, "embeddings": 0},
        }) + "\n",
        encoding="utf-8",
    )
    storage = MagicMock()
    storage.load_graph.return_value = object()
    with patch("horus_source.core.ingestion.watcher.embed_graph", return_value={}):
        result = ensure_current_embeddings(storage, tmp_path)

    assert result is True
    updated = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated["embeddings_complete"] is True
    assert "needs_reanalyze" not in updated


def test_ensure_current_embeddings_noop_when_complete(tmp_path) -> None:
    # Current model + scheme AND embeddings present → no re-embed.
    source_dir = tmp_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(
        json.dumps({
            "embedding_model": _DEFAULT_MODEL,
            "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
            "embeddings_complete": True,
            "stats": {"symbols": 100, "embeddings": 100},
        }) + "\n",
        encoding="utf-8",
    )
    storage = MagicMock()
    assert ensure_current_embeddings(storage, tmp_path) is False
    storage.load_graph.assert_not_called()


def test_ensure_current_embeddings_reembeds_and_updates_meta(tmp_path) -> None:
    repo_path = tmp_path
    source_dir = repo_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(
        json.dumps({"embedding_model": "BAAI/bge-small-en-v1.5"}) + "\n",
        encoding="utf-8",
    )

    storage = MagicMock()
    storage.load_graph.return_value = object()

    with patch("horus_source.core.ingestion.watcher.embed_graph", return_value={"node-1": [0.1, 0.2]}):
        migrated = ensure_current_embeddings(storage, repo_path)

    assert migrated is True
    storage.load_graph.assert_called_once_with()
    storage.store_embeddings.assert_called_once_with({"node-1": [0.1, 0.2]})
    updated_meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated_meta["embedding_model"] == _DEFAULT_MODEL
    assert updated_meta["embedding_scheme_version"] == EMBEDDING_SCHEME_VERSION


def test_ensure_current_embeddings_reembeds_when_scheme_outdated(tmp_path) -> None:
    # Model is current but the embedding INPUT scheme changed (prefixes / generate_text):
    # stored vectors are stale and MUST be regenerated, else new prefixed queries would be
    # compared against old prefix-less document vectors.
    repo_path = tmp_path
    source_dir = repo_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    meta_path = source_dir / "meta.json"
    meta_path.write_text(
        json.dumps({"embedding_model": _DEFAULT_MODEL})  # no scheme key == legacy scheme
        + "\n",
        encoding="utf-8",
    )

    storage = MagicMock()
    storage.load_graph.return_value = object()

    with patch(
        "horus_source.core.ingestion.watcher.embed_graph",
        return_value={"node-1": [0.1, 0.2]},
    ):
        migrated = ensure_current_embeddings(storage, repo_path)

    assert migrated is True
    storage.store_embeddings.assert_called_once()
    updated_meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert updated_meta["embedding_scheme_version"] == EMBEDDING_SCHEME_VERSION


def test_ensure_current_embeddings_noop_when_model_and_scheme_match(tmp_path) -> None:
    repo_path = tmp_path
    source_dir = repo_path / ".horus" / "source"
    source_dir.mkdir(parents=True)
    (source_dir / "meta.json").write_text(
        json.dumps(
            {
                "embedding_model": _DEFAULT_MODEL,
                "embedding_scheme_version": EMBEDDING_SCHEME_VERSION,
            }
        )
        + "\n",
        encoding="utf-8",
    )

    storage = MagicMock()

    migrated = ensure_current_embeddings(storage, repo_path)

    assert migrated is False
    storage.load_graph.assert_not_called()
    storage.store_embeddings.assert_not_called()
