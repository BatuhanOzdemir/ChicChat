"""Port Step 7 side-by-side check: replay identical conversations through the
TypeScript app and the Python app (each on its own identically seeded
database) and compare every HTTP response and the resulting database rows.

Usage: python side_by_side.py TS_URL PY_URL TS_DSN PY_DSN OUT_DIR
"""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import json
import re
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row

TS_URL, PY_URL, TS_DSN, PY_DSN, OUT = sys.argv[1:6]
OUT_DIR = Path(OUT)
OUT_DIR.mkdir(parents=True, exist_ok=True)

M1 = "00000000-0000-0000-0000-000000000001"
M2 = "00000000-0000-0000-0000-000000000003"
SECRET = "sbs-secret"

PATHS_M1 = {
    "wismo": ["not_shipped", "shipped_not_arrived", "marked_delivered_not_received", "delayed"],
    "return": ["changed_mind", "doesnt_fit", "not_as_described", "arrived_too_late", "found_cheaper"],
    "exchange": ["different_size", "different_color", "different_item"],
    "refund_not_received": ["not_issued", "issued_not_in_account", "partial_refund", "wrong_amount"],
    "wrong_damaged_missing": ["wrong_item", "wrong_size_sent", "damaged", "defective", "item_missing"],
    "cancel_modify": ["cancel", "change_size_variant", "change_address", "change_payment"],
    "sizing_fit": ["which_size", "fit_measurements", "fabric_care", "in_stock"],
    "other": [None],
}
PATHS_M2 = {"iade": ["beden", "fikir_degisti"], "kargo": ["gelmedi", "gecikti"]}

TEXT_ANSWERS = {
    "order_number": "  #tr-100 432 ",
    "siparis_no": "TR-100 433",
    "date_returned": "2026-11-01",
}


class App:
    def __init__(self, name: str, base: str) -> None:
        self.name = name
        self.client = httpx.Client(base_url=base, timeout=180)
        self.client.get("/simulator")
        token = self.client.cookies.get("chicchat_csrf")
        self.headers = {"x-csrf-token": token} if token else {}

    def sim(self, body: dict[str, Any]) -> tuple[int, Any]:
        r = self.client.post("/api/simulator", json=body, headers=self.headers)
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, r.text

    def webhook(self, payload: bytes, signature: str | None) -> tuple[int, str]:
        headers = {"content-type": "application/json"}
        if signature:
            headers["x-hub-signature-256"] = signature
        r = self.client.post("/api/whatsapp/webhook", content=payload, headers=headers)
        return r.status_code, r.text

    def get(self, path: str) -> tuple[int, str]:
        r = self.client.get(path)
        return r.status_code, r.text


ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
WAMID = re.compile(r"wamid\.sim\.[0-9a-z.\-]+")


class Normalizer:
    """Replace values that legitimately differ (generated ids, clock times) with
    stable placeholders, numbered by first appearance so structure still has
    to match."""

    def __init__(self, numbered: bool = True) -> None:
        self.ids: dict[str, str] = {}
        self.numbered = numbered

    def _id(self, kind: str, value: str) -> str:
        if value.startswith("00000000-0000-0000-0000-"):
            return value  # seeded, identical on both sides
        if not self.numbered:
            return f"<{kind}>"
        if value not in self.ids:
            self.ids[value] = f"<{kind}{len(self.ids) + 1}>"
        return self.ids[value]

    def text(self, value: str) -> str:
        value = ISO.sub("<ts>", value)
        value = UUID.sub(lambda m: self._id("id", m.group(0)), value)
        return WAMID.sub(lambda m: self._id("wamid", m.group(0)), value)

    def __call__(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {k: self(v) for k, v in sorted(value.items())}
        if isinstance(value, (list, tuple)):
            return [self(v) for v in value]
        if isinstance(value, str):
            return self.text(value)
        if isinstance(value, (dt.datetime, dt.date)):
            return "<ts>"
        if isinstance(value, uuid.UUID):
            return self.text(str(value))
        return value


differences: list[str] = []

# Explained differences (docs/PORT.md §9), removed before comparing:
# E1  TypeScript leaked the whole session row into `sessionMeta` (an extra
#     `state` key, a copy of `session`); its declared type and the UI use only
#     created_at/updated_at, which is all Python sends.
# E2  The integration_down notice no longer promises "Step 9" (dropped).
# E3  `last_error` text of a failed Meta call is the HTTP client's own wording;
#     here Node fails before the sandbox proxy and Python gets its 403.
NOTICE_E2 = "integration_down accepted, but there is no connector to degrade"


def explain(value: Any) -> Any:
    if isinstance(value, list) and len(value) == 2 and isinstance(value[1], dict):
        body = value[1]
        meta = body.get("sessionMeta")
        if isinstance(meta, dict):
            meta.pop("state", None)
        notice = body.get("notice")
        if isinstance(notice, str) and notice.startswith(NOTICE_E2):
            body["notice"] = NOTICE_E2
    return value
steps_compared = 0


def compare(label: str, ts: Any, py: Any, nts: Normalizer, npy: Normalizer) -> None:
    global steps_compared
    steps_compared += 1
    a, b = nts(ts), npy(py)
    a, b = explain(a), explain(b)
    if a != b:
        differences.append(
            f"### {label}\nTS: {json.dumps(a, ensure_ascii=False, sort_keys=True)[:3000]}\n"
            f"PY: {json.dumps(b, ensure_ascii=False, sort_keys=True)[:3000]}\n"
        )


ts_app, py_app = App("ts", TS_URL), App("py", PY_URL)
n_ts, n_py = Normalizer(), Normalizer()


def both_sim(label: str, body: dict[str, Any]) -> tuple[Any, Any]:
    ts = ts_app.sim(body)
    py = py_app.sim(body)
    compare(label, ts, py, n_ts, n_py)
    return ts[1], py[1]


def last_prompt(resp: Any) -> dict[str, Any] | None:
    out = resp.get("outbound") if isinstance(resp, dict) else None
    return out[-1] if out else None


def choose(resp: Any, field_key: str | None) -> dict[str, Any]:
    """The answer a tester would give: first option of a list or button prompt,
    a photo for a media field, a fixed text otherwise."""
    prompt = last_prompt(resp) or {}
    inter = prompt.get("interactive") or {}
    if inter.get("type") == "list":
        return {"kind": "list", "value": inter["action"]["sections"][0]["rows"][0]["id"]}
    if inter.get("type") == "button":
        return {"kind": "list", "value": inter["action"]["buttons"][0]["reply"]["id"]}
    if field_key == "photo":
        return {"kind": "photo", "value": "media.sim.side-by-side"}
    return {"kind": "text", "value": TEXT_ANSWERS.get(field_key or "", f"answer for {field_key}")}


phone_counter = 0


def new_phone() -> str:
    global phone_counter
    phone_counter += 1
    return f"9055512{phone_counter:05d}"


def walk(merchant: str, category: str, sub: str | None, extra_first: list[dict[str, Any]] | None = None) -> None:
    phone = new_phone()
    label = f"{merchant[-1]}:{category}/{sub}"
    base = {"action": "message", "merchantId": merchant, "phone": phone}
    ts, py = both_sim(f"{label} greeting", {**base, "message": {"kind": "text", "value": "merhaba"}})
    for i, msg in enumerate(extra_first or []):
        ts, py = both_sim(f"{label} extra {i}", {**base, "message": msg})
    ts, py = both_sim(f"{label} category", {**base, "message": {"kind": "list", "value": category}})
    if sub:
        ts, py = both_sim(f"{label} subcategory", {**base, "message": {"kind": "list", "value": sub}})
    for step in range(25):
        if not isinstance(py, dict) or py.get("completedCase") or py.get("error"):
            break
        key = (py.get("session") or {}).get("pendingFieldKey")
        answer = choose(py, key)
        ts, py = both_sim(f"{label} field {step} ({key})", {**base, "message": answer})


# 1. Every category/subcategory path, both merchants.
for cat, subs in PATHS_M1.items():
    for sub in subs:
        walk(M1, cat, sub)
for cat, subs in PATHS_M2.items():
    for sub in subs:
        walk(M2, cat, sub)

# 2. Recovery paths: unrecognized input, invalid order number, typed labels.
walk(M1, "return", "doesnt_fit", extra_first=[{"kind": "text", "value": "asdf qwerty"}, {"kind": "text", "value": "Return request"}])
phone = new_phone()
base = {"action": "message", "merchantId": M1, "phone": phone}
for i, msg in enumerate([
    {"kind": "text", "value": "hi"},
    {"kind": "text", "value": "2"},
    {"kind": "text", "value": "doesn't fit"},
    {"kind": "text", "value": "###"},
    {"kind": "text", "value": "tr 100-432"},
    {"kind": "text", "value": "blue shirt"},
    {"kind": "text", "value": "it doesn't fit"},
    {"kind": "text", "value": "too tight"},
    {"kind": "text", "value": "Wrong size"},
]):
    both_sim(f"typed-path step {i}", {**base, "message": msg})

# 3. Duplicate delivery (same message id twice) and a flow reply.
phone = new_phone()
base = {"action": "message", "merchantId": M1, "phone": phone}
dup = {"kind": "text", "value": "hi", "messageId": "wamid.sim.duplicate-1"}
both_sim("duplicate first", {**base, "message": dup})
both_sim("duplicate second", {**base, "message": dup})
both_sim("flow category", {**base, "message": {"kind": "list", "value": "exchange"}})
both_sim("flow subcategory", {**base, "message": {"kind": "list", "value": "different_size"}})
both_sim("flow order", {**base, "message": {"kind": "text", "value": "TR100999"}})
both_sim("flow item", {**base, "message": {"kind": "flow", "value": '{"item_ref":"Chino Trousers — Beige / 32"}'}})

# 4. State, reset, inactivity (nudge, abandon) through time travel + maintenance.
phone = new_phone()
base = {"merchantId": M1, "phone": phone}
both_sim("inactive greeting", {**base, "action": "message", "message": {"kind": "text", "value": "hi"}})
both_sim("inactive category", {**base, "action": "message", "message": {"kind": "list", "value": "return"}})
both_sim("inactive sub", {**base, "action": "message", "message": {"kind": "list", "value": "doesnt_fit"}})
both_sim("inactive order", {**base, "action": "message", "message": {"kind": "text", "value": "TR100432"}})
both_sim("state", {**base, "action": "state"})
both_sim("travel 10 min", {**base, "action": "time_travel", "ageMinutes": 10})
both_sim("maintenance nudge", {**base, "action": "maintenance"})
both_sim("maintenance again (no second nudge)", {**base, "action": "maintenance"})
both_sim("travel 25 h", {**base, "action": "time_travel", "ageMinutes": 1500})
both_sim("maintenance abandon", {**base, "action": "maintenance"})
both_sim("state after abandon", {**base, "action": "state"})
phone = new_phone()
base = {"merchantId": M1, "phone": phone}
both_sim("reset greeting", {**base, "action": "message", "message": {"kind": "text", "value": "hi"}})
both_sim("reset", {**base, "action": "reset"})
both_sim("state after reset", {**base, "action": "state"})
both_sim("time travel without session", {**base, "action": "time_travel", "ageMinutes": 10})

# 5. Error injection and delivery retry.
phone = new_phone()
base = {"merchantId": M1, "phone": phone}
both_sim("handler exception", {**base, "action": "message", "injectError": "handler_exception", "message": {"kind": "text", "value": "hi"}})
both_sim("after exception", {**base, "action": "message", "message": {"kind": "text", "value": "hi"}})
both_sim("delivery failure", {**base, "action": "message", "injectError": "delivery_failure", "message": {"kind": "list", "value": "wismo"}})
both_sim("retry delivery", {**base, "action": "retry_delivery"})
both_sim("integration down", {**base, "action": "message", "injectError": "integration_down", "message": {"kind": "list", "value": "delayed"}})

# 6. Invalid simulator requests.
for i, body in enumerate([
    {},
    {"action": "fly", "merchantId": M1, "phone": "905551234567"},
    {"action": "message", "merchantId": M1, "phone": "12"},
    {"action": "message", "merchantId": M1, "phone": "905551234567", "message": {"kind": "text", "value": ""}},
    {"action": "time_travel", "merchantId": M1, "phone": "905551234567", "ageMinutes": -1},
    {"action": "message", "merchantId": M1, "phone": "905551234567", "injectError": "nope", "message": {"kind": "text", "value": "x"}},
    {"action": "state", "merchantId": "00000000-0000-0000-0000-00000000dead", "phone": "905551234567"},
]):
    both_sim(f"invalid request {i}", body)

# 7. The real webhook: verification handshake, signatures, an inbound message.
for path in [
    "/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42",
    "/api/whatsapp/webhook",
    "/api/health",
    "/api/maintenance/sessions",
]:
    compare(f"GET {path}", ts_app.get(path), py_app.get(path), n_ts, n_py)


def envelope(phone: str, text: str, mid: str, pnid: str = "demo-phone-number-id") -> bytes:
    return json.dumps({
        "object": "whatsapp_business_account",
        "entry": [{"id": "waba", "changes": [{"field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": "905550000000", "phone_number_id": pnid},
            "contacts": [{"profile": {"name": "Side By Side"}, "wa_id": phone}],
            "messages": [{"from": phone, "id": mid, "timestamp": str(int(time.time())), "type": "text", "text": {"body": text}}],
        }}]}],
    }).encode()


def sign(body: bytes) -> str:
    return "sha256=" + hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()


wphone = new_phone()
cases = [
    ("webhook unsigned", envelope(wphone, "hi", "wamid.hook.1"), None),
    ("webhook bad signature", envelope(wphone, "hi", "wamid.hook.1"), "sha256=00"),
    ("webhook malformed json", b"{not json", sign(b"{not json")),
    ("webhook valid", envelope(wphone, "hi", "wamid.hook.1"), "SIGN"),
    ("webhook duplicate", envelope(wphone, "hi", "wamid.hook.1"), "SIGN"),
    ("webhook unknown number", envelope(wphone, "hi", "wamid.hook.2", "unknown-pnid"), "SIGN"),
    ("webhook second merchant", envelope(wphone, "merhaba", "wamid.hook.3", "second-merchant-phone-number-id"), "SIGN"),
]
for label, body, sig in cases:
    s = sign(body) if sig == "SIGN" else sig
    compare(label, ts_app.webhook(body, s), py_app.webhook(body, s), n_ts, n_py)
time.sleep(5)  # let after-response processing finish on both sides

# 8. Database rows produced by everything above.
TABLES = {
    "cases": "select c.*, cat.key as category_key, sub.key as subcategory_key from cases c left join categories cat on cat.id=c.category_id left join subcategories sub on sub.id=c.subcategory_id",
    "case_fields": "select f.* from case_fields f",
    "case_items": "select * from case_items",
    "case_events": "select * from case_events",
    "conversation_messages": "select * from conversation_messages",
    "conversation_media": "select id, merchant_id, customer_wa_id, media_id, mime_type, md5(content) as content_md5, case_id from conversation_media",
    "intake_sessions": "select * from intake_sessions",
    "processed_messages": "select * from processed_messages",
    "message_inbox": "select * from message_inbox",
    "message_outbox": "select * from message_outbox",
}
ORDER_HINTS = ["customer_wa_id", "created_at", "id"]


def dump(dsn: str, sql: str) -> list[dict[str, Any]]:
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        rows = conn.execute(sql).fetchall()
    return rows


def stable(rows: list[dict[str, Any]], norm: Normalizer) -> list[Any]:
    # Order by creation time (then phone) so id numbering follows the scenario,
    # not storage order.
    def key(r: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(str(r.get(k, "")) for k in ("created_at", "customer_wa_id", "position", "field_key", "seq"))
    return [norm(r) for r in sorted(rows, key=key)]


row_counts: dict[str, tuple[int, int]] = {}
for table, sql in TABLES.items():
    try:
        a, b = dump(TS_DSN, sql), dump(PY_DSN, sql)
    except psycopg.Error as err:
        differences.append(f"### table {table}: query failed: {err}\n")
        continue
    row_counts[table] = (len(a), len(b))
    for row in (*a, *b):
        if row.get("last_error"):
            row["last_error"] = "<E3>"
    na, nb = stable(a, Normalizer(False)), stable(b, Normalizer(False))
    if na != nb:
        # Compare as multisets too: ordering by equal timestamps can differ.
        sa = sorted(json.dumps(x, sort_keys=True, default=str, ensure_ascii=False) for x in na)
        sb = sorted(json.dumps(x, sort_keys=True, default=str, ensure_ascii=False) for x in nb)
        if sa != sb:
            only_a = [x for x in sa if x not in sb][:5]
            only_b = [x for x in sb if x not in sa][:5]
            differences.append(f"### table {table} ({len(a)} vs {len(b)} rows)\nonly TS: {only_a}\nonly PY: {only_b}\n")

report = OUT_DIR / "report.md"
lines = [
    "# Side-by-side: TypeScript vs Python",
    f"HTTP exchanges compared: {steps_compared}",
    "Row counts (TS, PY): " + ", ".join(f"{t}={c}" for t, c in row_counts.items()),
    f"Differences: {len(differences)}",
    "",
    *differences,
]
report.write_text("\n".join(lines))
print("\n".join(lines[:4]))
