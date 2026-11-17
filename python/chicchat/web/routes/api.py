"""API routes — ports of app/api/*/route.ts.

Status codes, headers and JSON bodies are identical to the TypeScript routes
(docs/PORT.md §2, "HTTP surface that must behave identically").
"""

from __future__ import annotations

import os
import re
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import PlainTextResponse, RedirectResponse, Response

from chicchat.db.client import PoolDatabase
from chicchat.db.media import case_photo
from chicchat.db.merchants import primary_channel, resolve_merchant_by_phone_number_id
from chicchat.db.privacy import enforce_retention
from chicchat.domain.auth.gate import constant_time_equal
from chicchat.domain.jscompat import js_json_parse
from chicchat.domain.result import Err
from chicchat.domain.simulator.presets import find_preset, next_step
from chicchat.domain.simulator.protocol import parse_simulator_request
from chicchat.domain.whatsapp import (
    parse_inbound,
    verify_signature,
    verify_webhook_challenge,
)
from chicchat.domain.whatsapp.types import OutboundMessage
from chicchat.server.env import (
    check_environment,
    development_access,
    is_production,
    is_simulator_enabled,
)
from chicchat.server.logger import error_message, logger
from chicchat.server.maintenance import MaintenanceDeps, run_session_maintenance
from chicchat.server.merchant import MERCHANT_COOKIE
from chicchat.server.simulator import run_simulator_action
from chicchat.server.whatsapp.client import Sender, graph_sender
from chicchat.server.whatsapp.config import get_whatsapp_config
from chicchat.server.whatsapp.inbox import (
    AcceptedMessage,
    accept_messages,
    process_inbox,
)
from chicchat.server.whatsapp.outbox import retry_replies
from chicchat.web import deps
from chicchat.web.jsonutil import json_response
from chicchat.web.security import set_private_cookie, verify_csrf

router = APIRouter()


# --- WhatsApp webhook ---------------------------------------------------------


@router.get("/api/whatsapp/webhook")
def webhook_handshake(request: Request) -> Response:
    """Meta verification handshake."""
    params = request.query_params
    challenge = verify_webhook_challenge(
        params.get("hub.mode"),
        params.get("hub.verify_token"),
        params.get("hub.challenge"),
        get_whatsapp_config().verify_token,
    )
    if challenge is None:
        logger.warn("webhook_rejected", {"reason": "verification_failed"})
        return PlainTextResponse("forbidden", status_code=403)
    return PlainTextResponse(challenge, status_code=200)


def _signature_ok(raw: bytes, request: Request, app_secret: str | None) -> bool:
    """Signature verification is mandatory; only local development may opt out."""
    if app_secret:
        return verify_signature(
            raw, request.headers.get("x-hub-signature-256"), app_secret
        )
    if is_production():
        logger.error(
            "webhook_rejected",
            RuntimeError("WHATSAPP_APP_SECRET not set"),
            {"reason": "missing_app_secret"},
        )
        return False
    logger.warn(
        "webhook_rejected",
        {
            "reason": "signature_unverified_dev_only",
            "detail": "set WHATSAPP_APP_SECRET to enable X-Hub-Signature-256 verification",
        },
    )
    return True


def _merchant_sender(db: PoolDatabase) -> Any:
    """Sends each message from its own merchant's number (SPEC §10), caching
    one sender per merchant for the run."""
    cfg = get_whatsapp_config()
    senders: dict[str, Sender] = {}

    def send(merchant_id: str, message: OutboundMessage) -> None:
        sender = senders.get(merchant_id)
        if sender is None:
            channel = primary_channel(db, merchant_id)
            if channel is None:
                raise RuntimeError("merchant channel unavailable")
            sender = graph_sender(cfg, channel.phone_number_id)
            senders[merchant_id] = sender
        sender(message)

    return send


def process_inbox_after_response(db: PoolDatabase) -> None:
    """Runs after the 200 is sent. Errors are logged, never lost silently
    (PORT.md P6); maintenance recovers anything left unprocessed."""
    try:
        process_inbox(db, _merchant_sender(db))
    except Exception as err:
        logger.error("unexpected_exception", err, {"during": "inbox_worker"})


@router.post("/api/whatsapp/webhook")
async def webhook(request: Request, background: BackgroundTasks) -> Response:
    """Verify the signature over the raw bytes, commit accepted messages to the
    inbox, then acknowledge with 200 and process after the response. Failed
    storage returns 503 so Meta retries."""
    cfg = get_whatsapp_config()
    raw = await request.body()
    if not _signature_ok(raw, request, cfg.app_secret):
        return PlainTextResponse("invalid signature", status_code=401)
    try:
        body = js_json_parse(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        logger.warn("validation_failed", {"reason": "malformed_json"})
        return PlainTextResponse("ok", status_code=200)  # SPEC §13: log, drop, 200.

    messages = parse_inbound(body)
    logger.info("webhook_received", {"messages": len(messages)})
    db = deps.database()

    def accept() -> None:
        accepted = []
        for inbound in messages:
            channel = resolve_merchant_by_phone_number_id(db, inbound["phoneNumberId"])
            if channel is not None:
                accepted.append(AcceptedMessage(channel.merchant_id, inbound))
            else:
                logger.warn(
                    "webhook_rejected",
                    {
                        "reason": "unknown_phone_number_id",
                        "correlationId": inbound["messageId"],
                    },
                )
        accept_messages(db, accepted)

    try:
        await run_in_threadpool(accept)
    except Exception as err:
        logger.error("unexpected_exception", err, {"during": "inbox_accept"})
        # No durable copy exists: a 503 deliberately requests redelivery from Meta.
        return PlainTextResponse("temporarily unavailable", status_code=503)
    background.add_task(process_inbox_after_response, db)
    return PlainTextResponse("ok", status_code=200)


# --- Maintenance --------------------------------------------------------------


def _maintenance_authorized(request: Request) -> bool:
    """CRON_SECRET is the name platform schedulers set; MAINTENANCE_SECRET is
    for calling the job by hand. Either is sufficient. Without one configured,
    allowed locally and refused in production."""
    secrets = [
        s
        for s in (os.environ.get("MAINTENANCE_SECRET"), os.environ.get("CRON_SECRET"))
        if s and s.strip()
    ]
    if secrets:
        header = request.headers.get("authorization", "")
        return any(
            constant_time_equal(header, f"Bearer {secret}") for secret in secrets
        )
    return not is_production()


def _run_maintenance() -> dict[str, Any]:
    db = deps.database()
    send = _merchant_sender(db)
    deleted_records = enforce_retention(db)
    inbox = process_inbox(db, send)
    sessions = run_session_maintenance(
        MaintenanceDeps(db=db, send=send), None, None, "whatsapp"
    )
    replies = retry_replies(db, send)
    return {
        "nudged": sessions.nudged,
        "abandoned": sessions.abandoned,
        "deleted": sessions.deleted,
        "failed": sessions.failed + inbox["failed"] + replies["failed"],
        "inbox": inbox,
        "replies": replies,
        "deletedRecords": deleted_records,
    }


@router.api_route("/api/maintenance/sessions", methods=["GET", "POST"])
async def maintenance(request: Request) -> Response:
    """Scheduled invocations arrive as GET; manual ones as POST."""
    if not _maintenance_authorized(request):
        logger.warn("webhook_rejected", {"reason": "maintenance_unauthorized"})
        return json_response({"error": "unauthorized"}, 401)
    try:
        return json_response(await run_in_threadpool(_run_maintenance), 200)
    except Exception as err:
        logger.error("unexpected_exception", err, {"during": "session_maintenance"})
        return json_response({"error": "maintenance failed"}, 500)


# --- Health ---------------------------------------------------------------------


@router.get("/api/health")
def health() -> Response:
    """Ungated, so deliberately uninformative: whether the database answers and
    how many configuration warnings there are — never which."""
    warnings = check_environment().warnings
    try:
        deps.database().query("select 1")
    except Exception as err:
        logger.error("unexpected_exception", err, {"during": "health_check"})
        return json_response(
            {"ok": False, "database": "unreachable", "warnings": len(warnings)}, 503
        )
    return json_response({"ok": True, "database": "up", "warnings": len(warnings)}, 200)


# --- Simulator ------------------------------------------------------------------


@router.post("/api/simulator", dependencies=[Depends(verify_csrf)])
async def simulator(request: Request) -> Response:
    """Validate the body at the boundary, then delegate. No Meta credentials."""
    if not is_simulator_enabled():
        return json_response({"error": "simulator disabled"}, 404)
    try:
        body = js_json_parse((await request.body()).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return json_response({"error": "invalid JSON body"}, 400)
    parsed = parse_simulator_request(body)
    if isinstance(parsed, Err):
        return json_response({"error": parsed.error}, 400)
    request_value = parsed.value
    principal = await run_in_threadpool(deps.current_principal, request)
    if (principal is None and not development_access()) or (
        principal is not None
        and request_value.merchant_id not in principal.merchant_ids
    ):
        return json_response({"error": "forbidden"}, 403)
    try:
        result = await run_in_threadpool(
            run_simulator_action, deps.database(), request_value
        )
    except Exception as err:
        # The simulator surfaces its own failures instead of hiding them.
        return json_response({"error": error_message(err)}, 500)
    response = json_response(result.to_json(), 200)
    set_private_cookie(response, MERCHANT_COOKIE, request_value.merchant_id, 2592000)
    return response


@router.post("/api/simulator/preset-step", dependencies=[Depends(verify_csrf)])
async def simulator_preset_step(request: Request) -> Response:
    """The next scripted answer for a preset (domain/simulator/presets.py).
    The browser only loops and honours Stop; the rule lives in Python."""
    if not is_simulator_enabled():
        return json_response({"error": "simulator disabled"}, 404)
    try:
        body = js_json_parse((await request.body()).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return json_response({"error": "invalid JSON body"}, 400)
    preset = find_preset(body.get("presetId", "")) if isinstance(body, dict) else None
    session = body.get("session") if isinstance(body, dict) else None
    visited = body.get("visited") if isinstance(body, dict) else None
    if preset is None or not isinstance(session, dict) or not isinstance(visited, list):
        return json_response(
            {"error": "presetId, session and visited are required"}, 400
        )
    step = next_step(preset, session, frozenset(str(v) for v in visited))
    message = (
        {"kind": step.message.kind, "value": step.message.value}
        if step.message
        else None
    )
    return json_response(
        {"message": message, "visitedKey": step.visited_key, "notice": step.notice}
    )


# --- Private photo evidence -------------------------------------------------------

_CASE_ID = re.compile(r"[a-f0-9-]{36}", re.IGNORECASE)


@router.get("/api/cases/{case_id}/media/{media_id}")
def case_media(case_id: str, media_id: str, request: Request) -> Response:
    if not _CASE_ID.fullmatch(case_id) or len(media_id) > 100:
        return PlainTextResponse("Not found", status_code=404)
    try:
        ctx = deps.current_merchant(request)
    except deps.LoginRequiredError:
        return RedirectResponse("/login", status_code=307)
    photo = (
        case_photo(deps.database(), ctx.current.id, case_id, media_id) if ctx else None
    )
    if photo is None:
        return PlainTextResponse("Photo unavailable", status_code=404)
    return Response(
        content=bytes(photo["content"]),
        media_type=photo["mime_type"],
        headers={
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )
