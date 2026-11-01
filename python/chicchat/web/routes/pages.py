"""Operator pages — ports of app/(app)/*/page.tsx and their server actions.

Every page resolves the signed-in account and the selected merchant first, so
everything below is scoped to a tenant the account belongs to (Step 6).
"""

from __future__ import annotations

import json
import math
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlencode

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response

from chicchat.db import case_queries, console, taxonomy
from chicchat.db.cases import build_handoff
from chicchat.db.config import load_merchant_config
from chicchat.db.merchants import list_channels
from chicchat.db.privacy import erase_customer
from chicchat.db.transcript import list_transcript
from chicchat.domain.auth.gate import safe_next_path
from chicchat.domain.cases.analytics import abandonment_rate
from chicchat.domain.cases.filters import (
    CASE_STATUSES,
    UNROUTED_QUEUE,
    parse_case_filters,
)
from chicchat.domain.cases.workflow import age_label, next_statuses, parse_note
from chicchat.domain.config.forms import (
    ACTION_TYPES,
    FIELD_TYPES,
    NORMALIZE_RULES,
    PRIORITIES,
    parse_field,
    parse_named,
    parse_policy,
    parse_rule,
)
from chicchat.domain.dates import as_datetime, millis_between
from chicchat.domain.jscompat import js_json_stringify, js_trim
from chicchat.domain.logging.mask import mask_phone
from chicchat.domain.nav import active_section, visible_sections
from chicchat.domain.result import Err, Result
from chicchat.domain.simulator.presets import PRESETS
from chicchat.server.env import is_simulator_enabled
from chicchat.server.logger import logger
from chicchat.server.merchant import MERCHANT_COOKIE, MerchantContext
from chicchat.web import deps
from chicchat.web.jsonutil import dumps, json_response
from chicchat.web.security import set_private_cookie, verify_csrf
from chicchat.web.templating import environment, render

router = APIRouter()
protected = [Depends(verify_csrf)]

environment.filters["masked"] = lambda phone: mask_phone(str(phone or ""))


def page(request: Request, name: str, **context: Any) -> HTMLResponse:
    """Render an operator page with the section bar."""
    return render(
        request,
        name,
        nav_sections=visible_sections(is_simulator_enabled()),
        nav_active=active_section(request.url.path),
        **context,
    )


def not_found(request: Request) -> HTMLResponse:
    return render(request, "not_found.html", status_code=404)


def _merchant(request: Request) -> MerchantContext | None:
    return deps.current_merchant(request)


def _intake_seconds(detail: dict[str, Any]) -> float | None:
    started = detail.get("intake_started_at")
    if started is None:
        return None
    created, start = as_datetime(detail["created_at"]), as_datetime(started)
    assert created is not None and start is not None
    return millis_between(created, start) / 1000


# --- Landing page --------------------------------------------------------------------


@router.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    from chicchat.web.app import STATIC

    return Response((STATIC / "favicon.ico").read_bytes(), media_type="image/x-icon")


@router.get("/")
def home(request: Request) -> HTMLResponse:
    deps.require_principal(request)
    return render(request, "home.html")


# --- Merchant switcher -------------------------------------------------------------------


@router.post("/merchant", dependencies=protected)
async def select_merchant(request: Request) -> Response:
    """Switch which merchant the console pages act as (Step 6). The id comes
    from a form, so it is checked against the account's real list."""
    form = await request.form()
    requested = str(form.get("merchant_id") or "")
    back = safe_next_path(str(form.get("back") or "/cases"))
    context = _merchant(request)
    options = context.options if context else []
    response = RedirectResponse(back, status_code=303)
    if not any(m.id == requested for m in options):
        logger.warn(
            "validation_failed",
            {"error": "unknown merchant in switcher", "requested": requested},
        )
        return response
    set_private_cookie(response, MERCHANT_COOKIE, requested, 60 * 60 * 24 * 30)
    return response


# --- Cases ---------------------------------------------------------------------------------


@router.get("/cases")
def cases_page(request: Request) -> HTMLResponse:
    merchant = _merchant(request)
    if merchant is None:
        return page(request, "no_merchant.html", title="Cases")
    params = {key: request.query_params.getlist(key) for key in request.query_params}
    parsed = parse_case_filters(params)
    if isinstance(parsed, Err):
        return page(request, "cases.html", error=parsed.error)
    filters = parsed.value
    db = deps.database()
    merchant_id = merchant.current.id
    listing = case_queries.list_cases(db, merchant_id, filters)
    counters = case_queries.case_counters(db, merchant_id)
    return page(
        request,
        "cases.html",
        error=None,
        merchant=merchant,
        filters=filters,
        statuses=CASE_STATUSES,
        page=listing,
        pages=max(1, math.ceil(listing.total / case_queries.PAGE_SIZE)),
        counters=counters,
        abandonment=abandonment_rate(counters.completed, counters.abandoned),
        errored=case_queries.list_errored_sessions(db, merchant_id),
        category_options=case_queries.case_category_options(db, merchant_id),
        pending=case_queries.delivery_issues(db, merchant_id),
    )


@router.get("/cases/{case_id}")
def case_detail_page(case_id: str, request: Request) -> HTMLResponse:
    merchant = _merchant(request)
    # Scoped to the selected merchant, so another tenant's case is a 404 here.
    detail = _case_detail(merchant, case_id)
    if detail is None:
        return not_found(request)
    photos = [
        f["normalized_value"]
        for f in detail["fields"]
        if f["type"] == "media" and f["normalized_value"]
    ]
    timeline: list[dict[str, Any]] = []
    if detail["intake_started_at"]:
        timeline.append({"at": detail["intake_started_at"], "what": "Intake started"})
    timeline += [
        {"at": f["created_at"], "what": f"Captured {f['field_key']}"}
        for f in detail["fields"]
    ]
    timeline.append(
        {"at": detail["created_at"], "what": f"Case created ({detail['status']})"}
    )
    timeline.sort(
        key=lambda entry: as_datetime(entry["at"]) or datetime.min.replace(tzinfo=UTC)
    )
    return page(
        request,
        "case_detail.html",
        detail=detail,
        photos=photos,
        timeline=timeline,
        intake_seconds=_intake_seconds(detail),
    )


def _case_detail(
    merchant: MerchantContext | None, case_id: str
) -> dict[str, Any] | None:
    if merchant is None:
        return None
    try:
        return case_queries.get_case_detail(
            deps.database(), merchant.current.id, case_id
        )
    except Exception:  # a malformed id is simply not a case of this merchant
        return None


# --- Agent console ---------------------------------------------------------------------------


@router.get("/console")
def console_page(request: Request) -> HTMLResponse:
    merchant = _merchant(request)
    if merchant is None:
        return page(request, "no_merchant.html", title="Agent console")
    params = request.query_params
    status = js_trim(params.get("status", ""))
    filters = console.QueueFilters(
        queue=js_trim(params.get("queue", "")) or None,
        category_key=js_trim(params.get("category", "")) or None,
        # An unknown status falls back to "everything outstanding" — this is a
        # work queue, so it should always show work rather than an error page.
        status=status if status in CASE_STATUSES else None,
    )
    db = deps.database()
    merchant_id = merchant.current.id
    queues = console.list_queues(db, merchant_id)
    now = datetime.now(UTC)

    def queue_href(queue: str | None) -> str:
        query = {"queue": queue if queue is not None else UNROUTED_QUEUE}
        if filters.category_key:
            query["category"] = filters.category_key
        if filters.status:
            query["status"] = filters.status
        return "/console?" + urlencode(query)

    return page(
        request,
        "console.html",
        merchant=merchant,
        filters=filters,
        statuses=CASE_STATUSES,
        rows=console.list_queue(db, merchant_id, filters),
        queues=queues,
        outstanding=sum(q["n"] for q in queues),
        category_options=case_queries.case_category_options(db, merchant_id),
        queue_href=queue_href,
        age=lambda created: age_label(created, now),
    )


@router.get("/console/{case_id}")
def console_case_page(case_id: str, request: Request) -> HTMLResponse:
    merchant = _merchant(request)
    detail = _case_detail(merchant, case_id)
    if detail is None or merchant is None:
        return not_found(request)
    db = deps.database()
    merchant_id = merchant.current.id
    workflow = console.get_case_workflow(db, merchant_id, case_id)
    if workflow is None:
        return not_found(request)
    handoff = build_handoff(db, case_id)
    return page(
        request,
        "console_case.html",
        detail=detail,
        workflow=workflow,
        handoff=handoff,
        handoff_json=json.dumps(
            json.loads(dumps(handoff)), indent=2, ensure_ascii=False
        ),
        events=console.list_case_events(db, merchant_id, case_id),
        transcript=list_transcript(db, merchant_id, case_id),
        moves=next_statuses(workflow["status"]),
        intake_seconds=_intake_seconds(detail),
        error=request.query_params.get("error", ""),
    )


def _console_done(
    case_id: str, error: str | None = None, merchant_id: str | None = None
) -> Response:
    if error:
        logger.warn(
            "validation_failed",
            {"merchantId": merchant_id, "case_id": case_id, "error": error},
        )
        return RedirectResponse(
            f"/console/{case_id}?error={quote(error, safe='')}", status_code=303
        )
    return RedirectResponse(f"/console/{case_id}", status_code=303)


def _actor(request: Request) -> str:
    principal = deps.current_principal(request)
    return principal.username if principal else "local-developer"


@router.post("/console/{case_id}/status", dependencies=protected)
async def change_status(case_id: str, request: Request) -> Response:
    """Move a case's status, with an optional note (SPEC §9). The tenant comes
    from the switcher, never from the form."""
    form = await request.form()
    merchant = _merchant(request)
    if merchant is None:
        return _console_done(case_id, "no merchant selected")
    merchant_id = merchant.current.id
    raw_note = js_trim(str(form.get("note") or ""))
    note: str | None = None
    if raw_note != "":
        parsed = parse_note(raw_note)
        if isinstance(parsed, Err):
            return _console_done(case_id, parsed.error, merchant_id)
        note = parsed.value
    result = console.transition_case(
        deps.database(),
        merchant_id,
        case_id,
        str(form.get("to") or ""),
        note,
        _actor(request),
    )
    return _console_done(
        case_id, result.error if isinstance(result, Err) else None, merchant_id
    )


@router.post("/console/{case_id}/note", dependencies=protected)
async def add_note(case_id: str, request: Request) -> Response:
    """Add an internal note — never visible to the customer (SPEC §9)."""
    form = await request.form()
    merchant = _merchant(request)
    if merchant is None:
        return _console_done(case_id, "no merchant selected")
    merchant_id = merchant.current.id
    parsed = parse_note(str(form.get("note") or ""))
    if isinstance(parsed, Err):
        return _console_done(case_id, parsed.error, merchant_id)
    result = console.add_case_note(
        deps.database(), merchant_id, case_id, parsed.value, _actor(request)
    )
    return _console_done(
        case_id, result.error if isinstance(result, Err) else None, merchant_id
    )


# --- Configuration ---------------------------------------------------------------------------

FIELD_LABELS = {
    "string": "Free text",
    "enum": "Pick from a list",
    "media": "Photo",
    "ref": "Item description / reference",
}


@router.get("/config")
def config_page(request: Request) -> HTMLResponse:
    merchant_ctx = _merchant(request)
    db = deps.database()
    config = load_merchant_config(db, merchant_ctx.current.id) if merchant_ctx else None
    if merchant_ctx is None or config is None:
        return page(request, "no_merchant.html", title="Merchant configuration")
    merchant_id = merchant_ctx.current.id
    rules = taxonomy.list_rules(db, merchant_id)
    return page(
        request,
        "config.html",
        merchant_ctx=merchant_ctx,
        config=config,
        channels=list_channels(db, merchant_id),
        rules_by_category={
            c.id: [r for r in rules if r["category_id"] == c.id]
            for c in config.categories
        },
        enabled_count=len([c for c in config.categories if c.enabled]),
        error=request.query_params.get("error", ""),
        erased=request.query_params.get("erased", ""),
        field_types=FIELD_TYPES,
        field_labels=FIELD_LABELS,
        normalize_rules=NORMALIZE_RULES,
        action_types=ACTION_TYPES,
        priorities=PRIORITIES,
        condition_json=js_json_stringify,
    )


def _config_result(
    request: Request, error: str | None = None, merchant_id: str | None = None
) -> Response:
    """In-place saves (the page's script asks for JSON) report back without
    navigating; a plain form post falls back to a redirect."""
    if error:
        logger.warn("validation_failed", {"merchantId": merchant_id, "error": error})
    if "application/json" in request.headers.get("accept", ""):
        return json_response({"error": error} if error else {})
    return RedirectResponse(
        "/config" + (f"?error={quote(error, safe='')}" if error else ""),
        status_code=303,
    )


async def _tenant(request: Request) -> tuple[str | None, dict[str, str]]:
    """The merchant every write is scoped to — from the switcher's cookie,
    never from the submitted form — and the submitted values."""
    form = await request.form()
    values = {key: value for key, value in form.items() if isinstance(value, str)}
    merchant = _merchant(request)
    return (merchant.current.id if merchant else None), values


def _write(request: Request, merchant_id: str, result: Result[Any]) -> Response:
    return _config_result(
        request, result.error if isinstance(result, Err) else None, merchant_id
    )


@router.post("/config/{action}", dependencies=protected)
async def config_action(action: str, request: Request) -> Response:
    """The taxonomy editor's actions (port of config/actions.ts): each validates
    its form at the boundary with a pure parser before touching the database."""
    merchant_id, values = await _tenant(request)
    if merchant_id is None:
        return RedirectResponse("/login", status_code=303)
    db = deps.database()
    target = values.get("id", "")
    category_id = values.get("category_id", "")
    if action == "policy":
        policy = parse_policy(values)
        if isinstance(policy, Err):
            return _config_result(request, policy.error, merchant_id)
        taxonomy.update_policy(db, merchant_id, policy.value)
        return _config_result(request)
    if action in ("add-category", "save-category", "add-subcategory"):
        named = parse_named(
            values, "subcategory" if action == "add-subcategory" else "category"
        )
        if isinstance(named, Err):
            return _config_result(request, named.error, merchant_id)
        if action == "add-category":
            return _write(
                request,
                merchant_id,
                taxonomy.create_category(db, merchant_id, named.value),
            )
        if action == "add-subcategory":
            return _write(
                request,
                merchant_id,
                taxonomy.create_subcategory(db, merchant_id, category_id, named.value),
            )
        taxonomy.update_category(
            db,
            merchant_id,
            target,
            named.value.label,
            named.value.sort_order,
            "enabled" in values,
        )
        return _config_result(request)
    if action in ("add-field", "save-field"):
        field = parse_field(values)
        if isinstance(field, Err):
            return _config_result(request, field.error, merchant_id)
        if action == "add-field":
            return _write(
                request,
                merchant_id,
                taxonomy.create_field(db, merchant_id, category_id, field.value),
            )
        taxonomy.update_field(db, merchant_id, target, field.value)
        return _config_result(request)
    if action == "add-rule":
        rule = parse_rule(values)
        if isinstance(rule, Err):
            return _config_result(request, rule.error, merchant_id)
        return _write(
            request,
            merchant_id,
            taxonomy.create_rule(db, merchant_id, category_id, rule.value),
        )
    removers = {
        "remove-category": taxonomy.delete_category,
        "remove-subcategory": taxonomy.delete_subcategory,
        "remove-field": taxonomy.delete_field,
        "remove-rule": taxonomy.delete_rule,
    }
    if action in removers:
        removers[action](db, merchant_id, target)
        return _config_result(request)
    return not_found(request)


@router.post("/privacy/erase", dependencies=protected)
async def delete_customer_data(request: Request) -> Response:
    """Permanently erase one customer's data for this merchant (SPEC §12)."""
    merchant_id, values = await _tenant(request)
    phone = js_trim(values.get("phone", ""))
    valid_phone = phone.isascii() and phone.isdigit() and 7 <= len(phone) <= 15
    if not merchant_id or not valid_phone or values.get("confirm") != "delete":
        return RedirectResponse(
            "/config?error=Enter+a+valid+phone+number+and+confirm+deletion",
            status_code=303,
        )
    erase_customer(deps.database(), merchant_id, phone)
    return RedirectResponse("/config?erased=1", status_code=303)


# --- Simulator ---------------------------------------------------------------------------------


@router.get("/simulator")
def simulator_page(request: Request) -> HTMLResponse:
    # Development/demo surface only (SPEC §7).
    if not is_simulator_enabled():
        return not_found(request)
    context = _merchant(request)
    merchants = context.options if context else []
    return page(
        request,
        "simulator.html",
        merchants=merchants,
        selected_merchant_id=context.current.id if context else "",
        presets=PRESETS,
    )
