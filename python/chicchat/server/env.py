"""Deployment configuration check (Handbook §5) — port of server/env.ts.

A deployed instance is only useful if its environment is complete, and the
worst way to discover otherwise is a customer's message failing at 2am. This
runs once at boot and reports everything wrong at once.

**Production is the default** (docs/PORT.md P1): Next.js set NODE_ENV for us,
Python sets nothing, so only an explicit `CHICCHAT_ENV=development` turns on
the local conveniences (login bypass, optional webhook signatures, an
unsecured maintenance endpoint, the simulator).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def value(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def is_production() -> bool:
    return value("CHICCHAT_ENV") != "development"


@dataclass
class EnvReport:
    missing: list[str] = field(default_factory=list)
    """The app cannot do its job (no database)."""
    warnings: list[str] = field(default_factory=list)
    """It will run, but degraded in a way worth saying out loud."""


def check_environment(production: bool | None = None) -> EnvReport:
    production = is_production() if production is None else production
    report = EnvReport()
    if value("DATABASE_URL") == "":
        report.missing.append("DATABASE_URL")
    if production:
        # WhatsApp credentials are only required once Meta is wired up, so an
        # incomplete set is a warning: the console and simulator still work.
        whatsapp = [
            name
            for name in (
                "WHATSAPP_ACCESS_TOKEN",
                "WHATSAPP_VERIFY_TOKEN",
                "WHATSAPP_PHONE_NUMBER_ID",
            )
            if value(name) == ""
        ]
        if 0 < len(whatsapp) < 3:
            report.warnings.append(
                f"WhatsApp is partly configured; missing {', '.join(whatsapp)}"
            )
        if value("WHATSAPP_ACCESS_TOKEN") != "" and value("WHATSAPP_APP_SECRET") == "":
            report.warnings.append(
                "WHATSAPP_APP_SECRET is not set, so inbound webhooks will be rejected "
                "in production (signature verification is mandatory, SPEC §10)"
            )
        if value("MAINTENANCE_SECRET") == "" and value("CRON_SECRET") == "":
            report.warnings.append(
                "Neither MAINTENANCE_SECRET nor CRON_SECRET is set, so the inactivity "
                "job (SPEC §11) cannot be triggered on a schedule"
            )
        if value("SIMULATOR_ENABLED") == "true":
            report.warnings.append(
                "SIMULATOR_ENABLED=true — the simulator writes real cases in this "
                "deployment (it requires a named console account)"
            )
    return report


def format_env_report(report: EnvReport) -> str:
    lines: list[str] = []
    if report.missing:
        lines.append(f"missing required configuration: {', '.join(report.missing)}")
    lines.extend(f"warning: {warning}" for warning in report.warnings)
    return "\n".join(lines)


def is_simulator_enabled() -> bool:
    """Available outside production, and in production only when explicitly
    enabled (the sales demo behind named accounts)."""
    return not is_production() or value("SIMULATOR_ENABLED") == "true"


def development_access() -> bool:
    """The local-development login bypass; never in production."""
    return not is_production() and value("CONSOLE_AUTH_REQUIRED") != "true"
