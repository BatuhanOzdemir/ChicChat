import { it } from "vitest";
import {
  parseField,
  parseNamed,
  parsePolicy,
  parseRule,
} from "@/lib/config/forms";
import { isValidKey, slugifyKey } from "@/lib/config/keys";
import { EDGE_STRINGS, Recorder } from "./record";

it("records config", () => {
  const r = new Recorder("config");
  for (const s of [
    ...EDGE_STRINGS,
    "İade Talebi",
    "Kargo Şikâyeti",
    "Ödeme sorunu",
    "  --hello--  ",
    "Ünlü Çiçek Güzel",
    "ÂÉÁÍÓÚÑÃÕ",
    "1abc",
    "Σίσυφος",
  ]) {
    r.call("slugifyKey", slugifyKey, s);
    r.call("isValidKey", isValidKey, s);
    r.call("isValidKey", isValidKey, slugifyKey(s));
    r.call("parseNamed", parseNamed, { label: s }, "category");
    r.call("parseNamed", parseNamed, { label: "x", key: s }, "subcategory");
    r.call("parseField", parseField, { label: s, type: "string" });
    r.call("parseField", parseField, {
      label: "f",
      type: "enum",
      enum_values: s,
    });
  }
  const numbers = [
    "",
    "0",
    "1",
    "-1",
    "1.5",
    "1e1",
    "0x10",
    " 7 ",
    "abc",
    "Infinity",
    "1e400",
    "-0",
    "٣",
  ];
  for (const n of numbers) {
    r.call("parsePolicy", parsePolicy, { return_window_days: n });
    r.call("parsePolicy", parsePolicy, { nudge_after_minutes: n });
    r.call("parsePolicy", parsePolicy, { abandon_after_hours: n });
    r.call("parseNamed", parseNamed, { label: "a", sort_order: n }, "category");
    r.call("parseRule", parseRule, {
      action_type: "auto_reply",
      sort_order: n,
    });
  }
  for (const url of [
    "",
    "https://example.com/kvkk",
    "http://x",
    "not-a-url",
    "https://",
    "https://a b",
    "HTTPS://EXAMPLE.COM",
    "ftp://x",
    "https://ok\n",
  ])
    r.call("parsePolicy", parsePolicy, { kvkk_url: url });
  for (const re of [
    "",
    "^[A-Z0-9]{4,}$",
    "[unclosed",
    "(",
    "a{2,1}",
    "\\",
    "^(?<p>TR)\\d+$",
    "(?<=a)b",
    "[\\D]",
  ])
    r.call("parsePolicy", parsePolicy, { order_id_regex: re });
  r.call("parsePolicy", parsePolicy, {
    return_window_days: "45",
    refund_sla_days: "21",
    nudge_after_minutes: "10",
    abandon_after_hours: "48",
    retention_months: "6",
    kvkk_url: "https://example.com/kvkk",
    order_id_regex: "^[A-Z0-9]{4,}$",
  });
  for (const type of ["string", "enum", "media", "ref", "wizard", "", " enum "])
    r.call("parseField", parseField, { label: "Size", type });
  for (const ev of [
    "S, M, L",
    "a\nb\nc",
    "a,,b",
    ",",
    Array.from({ length: 11 }, (_, i) => `v${i}`).join(","),
    Array.from({ length: 10 }, (_, i) => `v${i}`).join("\n"),
    "Çok Büyük, Küçük",
  ])
    r.call("parseField", parseField, {
      label: "x",
      type: "enum",
      enum_values: ev,
      required: "on",
    });
  for (const rule of ["", "order_number", "phone", " order_number "])
    r.call("parseField", parseField, {
      label: "x",
      type: "string",
      normalize_rule: rule,
    });
  const conditions = [
    "",
    "{oops",
    '{"all":[]}',
    '{"all":[{"field":"subcategory","op":"eq","value":"damaged"}]}',
    "null",
    "[]",
    '{"field":"x","op":"eq","value":NaN}',
    '{"field":"x","op":"eq","value":1.0}',
    '{"field":"x","op":"gt","value":12345678901234567890}',
    '{"field":"x","op":"eq","value":-0}',
  ];
  for (const condition of conditions)
    for (const action of ["route", "auto_reply", "escalate", "teleport"])
      r.call("parseRule", parseRule, {
        action_type: action,
        condition,
        target_queue: action === "escalate" ? "" : "q",
      });
  for (const value of [
    "wrong_size",
    "1",
    "1.0",
    "true",
    "null",
    '"quoted"',
    "[1,2]",
    "{}",
    "",
    "NaN",
    "1e2",
  ])
    for (const op of ["eq", "in", "present", "", "wat"])
      r.call("parseRule", parseRule, {
        action_type: "auto_reply",
        condition_field: "reason",
        condition_op: op,
        condition_value: value,
      });
  for (const priority of ["", "high", "urgent", " low "])
    r.call("parseRule", parseRule, {
      action_type: "auto_reply",
      priority,
      label: " L ",
    });
  r.write();
});
