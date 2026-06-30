"""Host metadata route for shared Horus host discovery."""

from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(tags=["host"])


@router.get("/host")
def get_host_info(request: Request) -> dict:
    """Return metadata about the currently running Horus host.

    ``indexing`` is True while a fresh index or interrupted re-embed is still
    running in the background. The host binds its port and answers this route
    immediately, so callers treat the host as reachable and surface "indexing
    in progress" rather than waiting on a slow startup (HOR-425).
    """
    runtime = getattr(request.app.state, "runtime", None)
    indexing = bool(getattr(runtime, "indexing", False)) if runtime is not None else False
    return {
        "repoPath": str(request.app.state.repo_path) if request.app.state.repo_path else None,
        "hostUrl": getattr(request.app.state, "host_url", None),
        "mcpUrl": getattr(request.app.state, "mcp_url", None),
        "watch": getattr(request.app.state, "watch", False),
        "mode": getattr(request.app.state, "mode", "standalone"),
        "indexing": indexing,
    }
