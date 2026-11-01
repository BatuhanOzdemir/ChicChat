"""Run the web app:  uv run python -m chicchat.web

HOST (default 127.0.0.1), PORT (default 8000) and WEB_CONCURRENCY (worker
processes, default 1) come from the environment. The access log is off: it
would print full request URLs, including the webhook's query parameters
(docs/PORT.md P19); the app writes its own structured log lines instead.
Behind a TLS-terminating proxy, set FORWARDED_ALLOW_IPS to the proxy's address.
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "chicchat.web.app:app",
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8000")),
        workers=int(os.environ.get("WEB_CONCURRENCY", "1")),
        access_log=False,
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get("FORWARDED_ALLOW_IPS", "127.0.0.1"),
    )


if __name__ == "__main__":
    main()
