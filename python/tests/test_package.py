"""Smoke test: the package imports and every layer is present."""

import importlib


def test_every_layer_imports() -> None:
    for layer in ("domain", "db", "server", "web"):
        assert importlib.import_module(f"chicchat.{layer}") is not None
