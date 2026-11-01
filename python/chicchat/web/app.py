"""The FastAPI application — replaces Next.js's server, middleware.ts and
instrumentation.ts.

Run locally:  CHICCHAT_ENV=development uv run uvicorn chicchat.web.app:app --reload
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from chicchat.db.auth import session_principal
from chicchat.domain.auth.gate import (
    PASSCODE_COOKIE,
    gate_decision,
    is_open_path,
    safe_next_path,
)
from chicchat.server.env import (
    check_environment,
    format_env_report,
    is_production,
    value,
)
from chicchat.server.logger import logger
from chicchat.web import deps
from chicchat.web.routes import api, auth, pages
from chicchat.web.security import CSRF_COOKIE, csrf_token

STATIC = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Boot check: missing required configuration stops the app, loudly, rather
    than serving a broken or open console. Warnings are logged."""
    report = check_environment()
    summary = format_env_report(report)
    if report.missing:
        logger.error("validation_failed", RuntimeError(summary), {"during": "startup"})
        raise RuntimeError(f"ChicChat cannot start — {summary}")
    if report.warnings:
        logger.warn("validation_failed", {"during": "startup", "detail": summary})
    yield


def _authenticated(request: Request) -> bool:
    return (
        session_principal(deps.database(), request.cookies.get(PASSCODE_COOKIE))
        is not None
    )


async def gate(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """The front door (port of middleware.ts): the pure gate decides, this only
    translates its decision into a response."""
    path = request.url.path
    if is_open_path(path):
        return await call_next(request)
    try:
        authenticated = await run_in_threadpool(_authenticated, request)
    except Exception:
        return PlainTextResponse(
            "Authentication temporarily unavailable", status_code=503
        )
    decision = gate_decision(
        path,
        authenticated,
        is_production(),
        allow_development_access=value("CONSOLE_AUTH_REQUIRED") != "true",
    )
    if decision.kind == "allow":
        return await call_next(request)
    if decision.kind == "unavailable":
        return PlainTextResponse(
            f"ChicChat is not configured: {decision.reason}", status_code=503
        )
    return RedirectResponse(
        "/login?" + urlencode({"next": safe_next_path(decision.next)}), status_code=307
    )


async def issue_csrf_cookie(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """Give every browser its form token (double-submit cookie, PORT.md P4).
    Readable by the simulator's script, which sends it back as a header."""
    token = csrf_token(request)
    response = await call_next(request)
    if request.cookies.get(CSRF_COOKIE) != token:
        response.set_cookie(
            CSRF_COOKIE,
            token,
            httponly=False,
            samesite="lax",
            secure=is_production(),
            path="/",
        )
    return response


def create_app() -> FastAPI:
    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.middleware("http")(gate)
    app.middleware("http")(issue_csrf_cookie)
    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    app.include_router(api.router)
    app.include_router(auth.router)
    app.include_router(pages.router)

    @app.exception_handler(deps.LoginRequiredError)
    async def _login_required(
        request: Request, _exc: deps.LoginRequiredError
    ) -> Response:
        return RedirectResponse("/login", status_code=303)

    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException) -> Response:
        return PlainTextResponse(str(exc.detail), status_code=exc.status_code)

    return app


app = create_app()
