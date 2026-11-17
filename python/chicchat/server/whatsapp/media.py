"""Private photo download — port of server/whatsapp/media.ts.

Download promptly; short-lived Meta URLs are never exposed to the browser.
Trusts only Meta's HTTPS media hosts, without redirects or credentials in the
URL, accepts JPEG/PNG/WebP only, and stops reading at 10 MB while streaming
(PORT.md P18).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from chicchat.server.whatsapp.config import WhatsAppConfig

LIMIT = 10 * 1024 * 1024
TYPES = frozenset(["image/jpeg", "image/png", "image/webp"])
_MEDIA_ID = re.compile(r"[0-9]{1,80}")
_TRUSTED = ("facebook.com", "fbcdn.net", "fbsbx.com")


@dataclass(frozen=True)
class Photo:
    content: bytes
    mime_type: str


class MediaError(RuntimeError):
    pass


def _trusted(url: str) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    host = parts.hostname or ""
    return (
        parts.scheme == "https"
        and not parts.username
        and not parts.password
        and (port is None or port == 443)
        and any(host == h or host.endswith(f".{h}") for h in _TRUSTED)
    )


def download_photo(
    config: WhatsAppConfig, media_id: str, client: httpx.Client | None = None
) -> Photo:
    if not _MEDIA_ID.fullmatch(media_id):
        raise MediaError("invalid media identifier")
    headers = {"Authorization": f"Bearer {config.access_token}"}
    http = client or httpx.Client(timeout=15.0, follow_redirects=False)
    try:
        response = http.get(
            f"https://graph.facebook.com/{config.graph_version}/{media_id}",
            headers=headers,
        )
        if not response.is_success:
            raise MediaError(f"Media lookup failed (HTTP {response.status_code})")
        try:
            metadata = response.json()
        except ValueError as err:
            raise MediaError("invalid media metadata") from err
        if not isinstance(metadata, dict) or not isinstance(metadata.get("url"), str):
            raise MediaError("invalid media metadata")
        if not _trusted(metadata["url"]):
            raise MediaError("untrusted media host")
        with http.stream("GET", metadata["url"], headers=headers) as media:
            mime_type = (media.headers.get("content-type") or "").split(";")[0]
            if not media.is_success or mime_type not in TYPES:
                raise MediaError("unsupported or unavailable photo")
            chunks: list[bytes] = []
            size = 0
            for chunk in media.iter_bytes():
                size += len(chunk)
                if size > LIMIT:
                    raise MediaError("photo exceeds 10 MB")
                chunks.append(chunk)
        return Photo(content=b"".join(chunks), mime_type=mime_type)
    finally:
        if client is None:
            http.close()
