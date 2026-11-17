"""Vercel entrypoint: Vercel's Python runtime looks for an ASGI `app` in a file
with one of a few well-known names at the project root (docs/DEPLOYMENT.md).

Everywhere else, start the app with `python -m chicchat.web`.
"""

from chicchat.web.app import app

__all__ = ["app"]
