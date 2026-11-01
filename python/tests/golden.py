"""Golden-file comparison (docs/PORT.md §5).

`scripts/golden/*.golden.ts` runs the TypeScript implementation over recorded
inputs and writes `tests/golden/<module>.json`. These helpers replay every
recorded case through the Python implementation and require identical output.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from pathlib import Path
from typing import Any

GOLDEN_DIR = Path(__file__).parent / "golden"

UNDEFINED: dict[str, bool] = {"$undefined": True}


def cases(module: str) -> list[dict[str, Any]]:
    """All recorded cases for one TypeScript module."""
    path = GOLDEN_DIR / f"{module}.json"
    loaded: list[dict[str, Any]] = json.loads(path.read_text(encoding="utf-8"))
    return loaded


def by_function(module: str) -> Iterator[tuple[str, list[Any], dict[str, Any]]]:
    for case in cases(module):
        yield case["fn"], case["args"], case


def assert_golden(
    module: str,
    functions: Mapping[str, Callable[..., Any]],
) -> int:
    """Replay every case of `module`; return how many cases were checked.

    Each entry in `functions` takes the recorded (JSON) arguments and returns a
    JSON-compatible value shaped exactly like the TypeScript result, or raises
    when the TypeScript function threw.
    """
    checked = 0
    failures: list[str] = []
    for name, args, case in by_function(module):
        if name not in functions:
            failures.append(f"no Python mapping for {module}.{name}")
            continue
        try:
            actual: Any = functions[name](*args)
            outcome: dict[str, Any] = {"result": actual}
        except Exception as err:  # recorded as an expected-throw comparison
            outcome = {"error": type(err).__name__}
        expected = (
            {"error": "thrown"} if "error" in case else {"result": case["result"]}
        )
        if "error" in outcome and "error" in expected:
            checked += 1
            continue
        if outcome != expected:
            failures.append(
                f"{module}.{name}({json.dumps(args, ensure_ascii=False)[:200]})\n"
                f"  TypeScript: {json.dumps(expected, ensure_ascii=False)[:400]}\n"
                f"  Python:     {json.dumps(outcome, ensure_ascii=False)[:400]}"
            )
        checked += 1
    assert not failures, f"{len(failures)} golden mismatch(es):\n" + "\n".join(
        failures[:25]
    )
    assert checked > 0, f"no golden cases for {module}"
    return checked


_RENAMES = {
    "from_status": "from",
    "to_status": "to",
    "from_date": "from",
    "to_date": "to",
}


def _camel(name: str) -> str:
    if name in _RENAMES:
        return _RENAMES[name]
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def ts_json(value: Any) -> Any:
    """Convert a Python domain value into the JSON the TypeScript returned.

    `Ok`/`Err` become `{ok, value}`/`{ok, error}`; dataclass fields become
    camelCase keys; floats that are whole numbers become ints (JS numbers).
    """
    import dataclasses

    from chicchat.domain.result import Err, Ok

    if isinstance(value, Ok):
        return {"ok": True, "value": ts_json(value.value)}
    if isinstance(value, Err):
        return {"ok": False, "error": value.error}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            _camel(f.name): ts_json(getattr(value, f.name))
            for f in dataclasses.fields(value)
        }
    if isinstance(value, dict):
        return {key: ts_json(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return [ts_json(item) for item in value]
    if isinstance(value, float) and value.is_integer():
        # JavaScript prints large whole numbers by their shortest decimal form
        # (12345678901234567000), not the float's exact value.
        from decimal import Decimal

        return int(value) if abs(value) < 2**53 else int(Decimal(repr(value)))
    return value
