"""Named-account sign-in and sign-out — port of app/login.

Only opaque, server-validated session tokens reach cookies (PORT.md P5).
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from chicchat.db.auth import login, sign_out
from chicchat.domain.auth.gate import PASSCODE_COOKIE, safe_next_path
from chicchat.web import deps
from chicchat.web.security import set_private_cookie, verify_csrf
from chicchat.web.templating import render

router = APIRouter()


@router.get("/login")
def login_page(request: Request) -> HTMLResponse:
    params = request.query_params
    return render(
        request,
        "login.html",
        next=safe_next_path(params.get("next", "")),
        failed=params.get("error", "") != "",
    )


@router.post("/login", dependencies=[Depends(verify_csrf)])
async def sign_in(request: Request) -> Response:
    form = await request.form()
    next_path = safe_next_path(str(form.get("next") or ""))
    token = await run_in_threadpool(
        login,
        deps.database(),
        str(form.get("username") or ""),
        str(form.get("passcode") or ""),
    )
    if token is None:
        return RedirectResponse(
            f"/login?error=1&next={quote(next_path, safe='')}", status_code=303
        )
    response = RedirectResponse(next_path, status_code=303)
    set_private_cookie(response, PASSCODE_COOKIE, token, 43200)
    return response


@router.post("/logout", dependencies=[Depends(verify_csrf)])
async def logout(request: Request) -> Response:
    token = request.cookies.get(PASSCODE_COOKIE)
    if token:
        await run_in_threadpool(sign_out, deps.database(), token)
    response = RedirectResponse("/login", status_code=303)
    response.delete_cookie(PASSCODE_COOKIE, path="/")
    return response
