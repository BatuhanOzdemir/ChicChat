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
