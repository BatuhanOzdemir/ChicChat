"""WhatsApp Cloud API config from the environment — port of server/whatsapp/config.ts."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class WhatsAppConfig:
    graph_version: str
    phone_number_id: str
    access_token: str
    verify_token: str
    app_secret: str | None


def get_whatsapp_config() -> WhatsAppConfig:
    return WhatsAppConfig(
        graph_version=os.environ.get("WHATSAPP_GRAPH_VERSION") or "v22.0",
        phone_number_id=os.environ.get("WHATSAPP_PHONE_NUMBER_ID", ""),
        access_token=os.environ.get("WHATSAPP_ACCESS_TOKEN", ""),
        verify_token=os.environ.get("WHATSAPP_VERIFY_TOKEN", ""),
        app_secret=os.environ.get("WHATSAPP_APP_SECRET") or None,
    )
