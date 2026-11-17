"""JavaScript-compatible primitives for the port (docs/PORT.md §6).

The TypeScript implementation relied on JavaScript semantics that Python does
not share. Every domain module uses these helpers instead of the Python
built-ins wherever the difference could change behaviour:

- ``js_trim`` / ``JS_WS``: JavaScript's whitespace set (P16) — Python's
  ``str.strip`` and ``\\s`` differ (e.g. BOM, U+001C..U+001F, U+0085).
- ``js_round``: ``Math.round`` rounds halves up; Python rounds to even (P11).
- ``js_number``: ``Number(text)`` parsing rules (hex, ``Infinity``, no ``nan``).
- ``js_strict_equal`` / ``js_includes``: ``===`` and ``Array.includes`` —
  Python treats ``True == 1`` and compares lists/dicts by value.
- ``js_regex``: compiles a JavaScript regular expression (including
  merchant-entered patterns) so ``\\d``/``\\w`` stay ASCII, ``$`` means end of
  input, named groups work, and ``test`` searches anywhere (P9).
"""

from __future__ import annotations

import math
import re
from typing import Any

# ECMAScript WhiteSpace + LineTerminator code points (String.prototype.trim, \s).
_JS_WS_CHARS = "".join(
    chr(c)
    for c in (
        0x09,
        0x0A,
        0x0B,
        0x0C,
        0x0D,
        0x20,
        0xA0,
        0x1680,
        *range(0x2000, 0x200B),
        0x2028,
        0x2029,
        0x202F,
        0x205F,
        0x3000,
        0xFEFF,
    )
)
JS_WS = "[" + re.escape(_JS_WS_CHARS) + "]"
"""A regex character class matching exactly JavaScript's ``\\s``."""

_JS_WS_CLASS_BODY = re.escape(_JS_WS_CHARS)


def js_trim(text: str) -> str:
    """``String.prototype.trim``."""
    return text.strip(_JS_WS_CHARS)


def js_round(value: float) -> int:
    """``Math.round``: halves round towards +infinity (2.5 → 3, -2.5 → -2)."""
    return math.floor(value + 0.5)


_DECIMAL = re.compile(
    r"[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", re.ASCII
)
_RADIX = re.compile(r"0([xXoObB])([0-9a-fA-F]+)", re.ASCII)


def js_number(text: str) -> float:
    """``Number(text)`` for a string; returns ``nan`` where JavaScript gives NaN."""
    body = js_trim(text)
    if body == "":
        return 0.0
    if _DECIMAL.fullmatch(body):
        return float(body)
    if body in ("Infinity", "+Infinity"):
        return math.inf
    if body == "-Infinity":
        return -math.inf
    radix = _RADIX.fullmatch(body)
    if radix:
        base = {"x": 16, "o": 8, "b": 2}[radix.group(1).lower()]
        try:
            return float(int(radix.group(2), base))
        except ValueError:
            return math.nan
    return math.nan


def is_js_number(value: object) -> bool:
    """``typeof value === "number"`` (booleans are not numbers in JavaScript)."""
    return isinstance(value, int | float) and not isinstance(value, bool)


def js_typeof(value: object) -> str:
    """``typeof`` for JSON-shaped values."""
    if value is None:
        return "object"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    return "object"


def js_strict_equal(a: object, b: object) -> bool:
    """``a === b`` for JSON-shaped values (objects/arrays compare by identity)."""
    if is_js_number(a) and is_js_number(b):
        return float(a) == float(b)  # type: ignore[arg-type]
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if a is None or b is None:
        return a is b
    return a is b


def js_includes(items: list[Any], value: object) -> bool:
    """``Array.prototype.includes`` (SameValueZero: NaN matches NaN)."""
    for item in items:
        if js_strict_equal(item, value):
            return True
        if (
            is_js_number(item)
            and is_js_number(value)
            and math.isnan(float(item))
            and math.isnan(float(value))  # type: ignore[arg-type]
        ):
            return True
    return False


def js_truthy(value: object) -> bool:
    """JavaScript truthiness: empty lists/dicts are truthy, unlike Python (P10)."""
    if value is None or value is False or isinstance(value, JsUndefined):
        return False
    if is_js_number(value):
        return not (value == 0 or math.isnan(float(value)))  # type: ignore[arg-type]
    if isinstance(value, str):
        return value != ""
    return True


class JsRegexError(ValueError):
    """The pattern is not a valid JavaScript regex, or has no Python equivalent."""


_ASCII_CLASS = {
    "d": "0-9",
    "w": "A-Za-z0-9_",
    "s": _JS_WS_CLASS_BODY,
}
_NEGATED = {"D": "d", "W": "w", "S": "s"}


def _translate(source: str) -> str:
    """Rewrite JavaScript regex syntax into equivalent Python syntax."""
    out: list[str] = []
    i = 0
    in_class = False
    class_needs_ascii = False
    class_start = 0
    n = len(source)
    while i < n:
        ch = source[i]
        if ch == "\\":
            if i + 1 >= n:
                raise JsRegexError("\\ at end of pattern")
            nxt = source[i + 1]
            if nxt in _ASCII_CLASS:
                body = _ASCII_CLASS[nxt]
                out.append(body if in_class else f"[{body}]")
                i += 2
                continue
            if nxt in _NEGATED:
                if in_class:
                    # Python's \D, \W, \S inside a class are Unicode-aware; the
                    # class is wrapped in an ASCII-only group when it closes.
                    out.append(f"\\{nxt}")
                    class_needs_ascii = True
                    i += 2
                    continue
                out.append(f"[^{_ASCII_CLASS[_NEGATED[nxt]]}]")
                i += 2
                continue
            if nxt in "bB" and not in_class:
                word = "[A-Za-z0-9_]"
                boundary = f"(?:(?<={word})(?!{word})|(?<!{word})(?={word}))"
                out.append(boundary if nxt == "b" else f"(?!{boundary})")
                i += 2
                continue
            if nxt == "k" and not in_class and i + 2 < n and source[i + 2] == "<":
                end = source.find(">", i + 3)
                if end == -1:
                    raise JsRegexError("unterminated \\k<name>")
                out.append(f"(?P={source[i + 3 : end]})")
                i = end + 1
                continue
            if nxt == "/":
                out.append("/")
                i += 2
                continue
            out.append(source[i : i + 2])
            i += 2
            continue
        if in_class:
            if ch == "]":
                in_class = False
                if class_needs_ascii:
                    out.insert(class_start, "(?a:")
                    out.append("])")
                    class_needs_ascii = False
                    i += 1
                    continue
            elif ch == "[":
                out.append("\\[")  # literal in JS; a nested set warning in Python
                i += 1
                continue
            out.append(ch)
            i += 1
            continue
        if ch == "[":
            in_class = True
            class_start = len(out)
            out.append(ch)
            # A leading "]" closes nothing in Python but is an empty class in JS.
            if source.startswith("[^]", i):
                out[-1] = "[\\s\\S]"
                in_class = False
                i += 3
                continue
            if source.startswith("[]", i):
                out[-1] = "(?!)"
                in_class = False
                i += 2
                continue
            i += 1
            continue
        if ch == "$":
            out.append(r"(?!(?s:.))")  # end of input only, not before a final "\n"
            i += 1
            continue
        if (
            ch == "("
            and source.startswith("(?<", i)
            and not (source.startswith("(?<=", i) or source.startswith("(?<!", i))
        ):
            out.append("(?P<")
            i += 3
            continue
        out.append(ch)
        i += 1
    if in_class:
        raise JsRegexError("unterminated character class")
    return "".join(out)


def js_regex(source: str, flags: str = "") -> re.Pattern[str]:
    """Compile a JavaScript regex (``new RegExp(source, flags)``).

    Use ``.search`` to reproduce ``RegExp.prototype.test``. Raises
    ``JsRegexError`` where ``new RegExp`` would throw, or where Python has no
    equivalent.
    """
    py_flags = 0
    for flag in flags:
        if flag == "i":
            py_flags |= re.IGNORECASE
        elif flag == "m":
            py_flags |= re.MULTILINE
        elif flag == "s":
            py_flags |= re.DOTALL
        elif flag in "gyu":
            continue
        else:
            raise JsRegexError(f"invalid flag {flag!r}")
    translated = _translate(source)
    if py_flags & re.MULTILINE:
        translated = translated.replace(
            r"(?!(?s:.))", r"(?=[\n\r\u2028\u2029]|(?!(?s:.)))"
        )
    # "." in JavaScript excludes \n, \r, U+2028 and U+2029; Python only \n.
    if not py_flags & re.DOTALL:
        translated = _js_dot(translated)
    try:
        # No re.ASCII: \d, \w, \s and \b are already rewritten to their
        # JavaScript (ASCII) meaning above, and /i must still fold "ş"/"Ş".
        return re.compile(translated, py_flags)
    except (re.error, OverflowError, RecursionError) as err:
        raise JsRegexError(str(err)) from err


def _js_dot(pattern: str) -> str:
    """Make unescaped ``.`` outside classes exclude all JS line terminators."""
    out: list[str] = []
    i = 0
    in_class = False
    while i < len(pattern):
        ch = pattern[i]
        if ch == "\\":
            out.append(pattern[i : i + 2])
            i += 2
            continue
        if in_class:
            in_class = ch != "]"
        elif ch == "[":
            in_class = True
        elif ch == "." and not pattern.startswith("(?s:.)", i - 4):
            out.append("[^\\n\\r\\u2028\\u2029]")
            i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def js_test(pattern: re.Pattern[str], text: str) -> bool:
    """``RegExp.prototype.test`` for a non-global regex: search anywhere."""
    return pattern.search(text) is not None


def js_length(text: str) -> int:
    """``string.length``: UTF-16 code units (an emoji outside the BMP counts 2)."""
    return len(text.encode("utf-16-le")) // 2


def js_slice(text: str, start: int, end: int | None = None) -> str:
    """``string.slice`` by UTF-16 code units, as JavaScript truncates."""
    units = text.encode("utf-16-le")
    lo = start * 2
    hi = len(units) if end is None else end * 2
    return units[lo:hi].decode("utf-16-le", errors="surrogatepass")


def is_js_integer(value: float) -> bool:
    """``Number.isInteger``."""
    return math.isfinite(value) and float(value).is_integer()


_MAX_SAFE = 2**53


def _js_json_number(value: float) -> int | float:
    # JavaScript has one number type; integral values print without ".0".
    if math.isfinite(value) and value.is_integer() and abs(value) < _MAX_SAFE:
        return int(value)
    return value


def _reject_constant(name: str) -> Any:
    raise ValueError(f"invalid JSON constant {name}")


def js_json_parse(text: str) -> Any:
    """``JSON.parse``: rejects NaN/Infinity; numbers behave like JS numbers."""
    import json

    try:
        return _loads(json, text)
    except RecursionError as err:  # JSON.parse copes; treat as invalid input
        raise ValueError("JSON nested too deeply") from err


def _loads(json: Any, text: str) -> Any:
    return json.loads(
        text,
        parse_constant=_reject_constant,
        parse_float=lambda s: _js_json_number(float(s)),
        parse_int=lambda s: _js_json_number(float(s)) if len(s) > 15 else int(s),
    )


def js_json_stringify(value: object) -> str:
    """``JSON.stringify`` (no spacing) for JSON-shaped values."""
    import json

    def fix(item: object) -> object:
        if isinstance(item, float):
            return _js_json_number(item)
        if isinstance(item, dict):
            return {key: fix(child) for key, child in item.items()}
        if isinstance(item, list | tuple):
            return [fix(child) for child in item]
        return item

    return json.dumps(fix(value), ensure_ascii=False, separators=(",", ":"))


def js_number_to_string(value: float) -> str:
    """``String(number)``: "1" not "1.0", "1e+21", "1.5e-7", "NaN", "Infinity"."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    digits, exponent = _shortest_digits(abs(value))
    # `exponent` is the position of the decimal point relative to `digits`.
    n = exponent
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    mantissa = digits[0] + ("." + digits[1:] if k > 1 else "")
    return f"{sign}{mantissa}e{'+' if e >= 0 else '-'}{abs(e)}"


def _shortest_digits(value: float) -> tuple[str, int]:
    """Shortest round-trip decimal digits and point position (as ECMAScript)."""
    text = repr(value)
    mantissa, _, exp_text = text.partition("e")
    exp = int(exp_text) if exp_text else 0
    whole, _, frac = mantissa.partition(".")
    if frac == "0":
        frac = ""
    digits = (whole + frac).lstrip("0")
    point = len(whole) + exp
    if whole == "0":
        stripped = frac.lstrip("0")
        point = exp - (len(frac) - len(stripped))
        digits = stripped
    digits = digits.rstrip("0") or "0"
    return digits, point


def js_string(value: object) -> str:
    """``String(value)`` for JSON-shaped scalars."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if is_js_number(value):
        return js_number_to_string(float(value))  # type: ignore[arg-type]
    return str(value)


class JsUndefined:
    """JavaScript's ``undefined``, where it must be told apart from ``null``."""

    _instance: JsUndefined | None = None

    def __new__(cls) -> JsUndefined:
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __repr__(self) -> str:
        return "undefined"

    def __bool__(self) -> bool:
        return False


UNDEFINED = JsUndefined()


def js_get(obj: object, name: str) -> object:
    """``obj.name`` — raises TypeError on null/undefined, as JavaScript does."""
    if obj is None or obj is UNDEFINED:
        raise TypeError(f"Cannot read properties of {obj!r} (reading '{name}')")
    if isinstance(obj, dict):
        return obj.get(name, UNDEFINED)
    if isinstance(obj, str) and name == "length":
        return js_length(obj)
    return UNDEFINED


def js_opt(obj: object, name: str) -> object:
    """``obj?.name``."""
    if obj is None or obj is UNDEFINED:
        return UNDEFINED
    return js_get(obj, name)


def js_nullish(value: object, fallback: object) -> object:
    """``value ?? fallback``."""
    return fallback if value is None or value is UNDEFINED else value
