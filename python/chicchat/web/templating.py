"""Jinja2 templates with autoescaping always on (PORT.md P7).

Customer messages and merchant-entered labels are untrusted text shown inside
an operator's authenticated session, so nothing is ever marked `|safe`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import Request
from fastapi.responses import HTMLResponse
from jinja2 import Environment, FileSystemLoader, select_autoescape

from chicchat.domain.cases.analytics import format_duration, format_percent
from chicchat.domain.cases.date import format_date_time
from chicchat.web.jsonutil import dumps
from chicchat.web.security import CSRF_FIELD, csrf_token

TEMPLATES = Path(__file__).parent / "templates"

environment = Environment(
    loader=FileSystemLoader(TEMPLATES),
    autoescape=select_autoescape(
        enabled_extensions=("html",), default_for_string=True, default=True
    ),
    trim_blocks=True,
    lstrip_blocks=True,
)
environment.filters["datetime"] = format_date_time
environment.filters["duration"] = format_duration
environment.filters["percent"] = format_percent
environment.filters["tojson_js"] = dumps


def render(
    request: Request, name: str, status_code: int = 200, **context: Any
) -> HTMLResponse:
    token = csrf_token(request)
    html = environment.get_template(name).render(
        request=request,
        csrf_field=CSRF_FIELD,
        csrf_token=token,
        path=request.url.path,
        **context,
    )
    return HTMLResponse(html, status_code=status_code)
