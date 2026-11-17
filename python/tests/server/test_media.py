"""Port of server/whatsapp/media.test.ts (pitfall P18)."""

from __future__ import annotations

import httpx
import pytest

from chicchat.server.whatsapp.config import WhatsAppConfig
from chicchat.server.whatsapp.media import MediaError, download_photo

CONFIG = WhatsAppConfig(
    graph_version="v22.0",
    access_token="test-token",
    phone_number_id="123",
    verify_token="unused",
    app_secret=None,
)


def client(*responses: httpx.Response) -> tuple[httpx.Client, list[httpx.Request]]:
    seen: list[httpx.Request] = []
    queue = list(responses)

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return queue.pop(0)

    return httpx.Client(
        transport=httpx.MockTransport(handler), follow_redirects=False
    ), seen


def test_retrieves_metadata_then_stores_authenticated_image_bytes() -> None:
    http, seen = client(
        httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/photo"}),
        httpx.Response(
            200, content=bytes([1, 2, 3]), headers={"content-type": "image/png"}
        ),
    )
    photo = download_photo(CONFIG, "123", http)
    assert photo.content == bytes([1, 2, 3])
    assert photo.mime_type == "image/png"
    assert seen[1].headers["authorization"] == "Bearer test-token"


def test_rejects_metadata_that_would_send_credentials_to_an_unrelated_host() -> None:
    http, seen = client(
        httpx.Response(200, json={"url": "https://facebook.com.evil.example/photo"})
    )
    with pytest.raises(MediaError, match="untrusted media host"):
        download_photo(CONFIG, "123", http)
    assert len(seen) == 1


def test_rejects_oversized_or_executable_content() -> None:
    big, _ = client(
        httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/photo"}),
        httpx.Response(
            200,
            content=bytes(10 * 1024 * 1024 + 1),
            headers={"content-type": "image/png"},
        ),
    )
    with pytest.raises(MediaError, match="exceeds"):
        download_photo(CONFIG, "123", big)
    html, _ = client(
        httpx.Response(200, json={"url": "https://lookaside.fbsbx.com/photo"}),
        httpx.Response(
            200, content=b"<script/>", headers={"content-type": "text/html"}
        ),
    )
    with pytest.raises(MediaError, match="unsupported"):
        download_photo(CONFIG, "123", html)


def test_treats_a_redirect_as_a_failure() -> None:
    http, _ = client(httpx.Response(302, headers={"location": "https://evil.example/"}))
    with pytest.raises(MediaError, match="Media lookup failed"):
        download_photo(CONFIG, "123", http)


@pytest.mark.parametrize(
    "url",
    [
        "http://lookaside.fbsbx.com/x",
        "https://user:pw@fbcdn.net/x",
        "https://fbcdn.net:8443/x",
        "https://evilfbcdn.net/x",
    ],
)
def test_rejects_untrusted_media_urls(url: str) -> None:
    http, _ = client(httpx.Response(200, json={"url": url}))
    with pytest.raises(MediaError, match="untrusted"):
        download_photo(CONFIG, "123", http)
