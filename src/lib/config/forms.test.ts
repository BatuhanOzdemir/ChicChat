import { describe, expect, it } from "vitest";
import { parseField, parseNamed, parsePolicy, parseRule } from "./forms";

describe("parsePolicy", () => {
  it("accepts a complete policy", () => {
    const r = parsePolicy({
      return_window_days: "45",
      refund_sla_days: "21",
      nudge_after_minutes: "10",
      abandon_after_hours: "48",
      retention_months: "6",
      kvkk_url: "https://example.com/kvkk",
      order_id_regex: "^[A-Z0-9]{4,}$",
    });
    expect(r).toEqual({
      ok: true,
      value: {
        returnWindowDays: 45,
        refundSlaDays: 21,
        nudgeAfterMinutes: 10,
        abandonAfterHours: 48,
        retentionMonths: 6,
        kvkkUrl: "https://example.com/kvkk",
        orderIdRegex: "^[A-Z0-9]{4,}$",
      },
    });
  });

  it("falls back to defaults for blank numbers", () => {
    const r = parsePolicy({});
    expect(r.ok && r.value.returnWindowDays).toBe(30);
    expect(r.ok && r.value.nudgeAfterMinutes).toBe(5);
    expect(r.ok && r.value.kvkkUrl).toBeNull();
  });

  it("rejects nonsense values", () => {
    expect(parsePolicy({ return_window_days: "-3" }).ok).toBe(false);
    expect(parsePolicy({ nudge_after_minutes: "0" }).ok).toBe(false);
    expect(parsePolicy({ kvkk_url: "not-a-url" }).ok).toBe(false);
    expect(parsePolicy({ order_id_regex: "[unclosed" }).ok).toBe(false);
  });
});

describe("parseNamed", () => {
  it("derives a key from the label", () => {
    const r = parseNamed({ label: "Kargo Hasarlı" }, "category");
    expect(r.ok && r.value).toEqual({
      key: "kargo_hasarli",
      label: "Kargo Hasarlı",
      sortOrder: 0,
    });
  });

  it("prefers an explicit key but still normalizes it", () => {
    const r = parseNamed({ label: "Damaged", key: "My Key" }, "category");
    expect(r.ok && r.value.key).toBe("my_key");
  });

  it("requires a label and a derivable key", () => {
    expect(parseNamed({}, "category")).toEqual({
      ok: false,
      error: "category label is required",
    });
    expect(parseNamed({ label: "!!!" }, "subcategory").ok).toBe(false);
  });
});

describe("parseField", () => {
  it("parses an enum field with values given one per line", () => {
    const r = parseField({
      label: "Damage type",
      type: "enum",
      required: "on",
      enum_values: "Torn seam\nStain\nBroken zip",
      sort_order: "20",
    });
    expect(r.ok && r.value).toEqual({
      key: "damage_type",
      label: "Damage type",
      type: "enum",
      required: true,
      enumValues: ["torn_seam", "stain", "broken_zip"],
      normalizeRule: null,
      sortOrder: 20,
    });
  });

  it("also accepts comma-separated enum values", () => {
    const r = parseField({
      label: "Size",
      type: "enum",
      enum_values: "S, M, L",
    });
    expect(r.ok && r.value.enumValues).toEqual(["s", "m", "l"]);
    expect(r.ok && r.value.required).toBe(false);
  });

  it("rejects more than ten enum values (WhatsApp list cap)", () => {
    const many = Array.from({ length: 11 }, (_, i) => `v${i}`).join(",");
    expect(parseField({ label: "x", type: "enum", enum_values: many })).toEqual(
      {
        ok: false,
        error: "an enum field can offer at most 10 values",
      },
    );
  });

  it("rejects an unknown type or an unusable key", () => {
    expect(parseField({ label: "x", type: "wizard" }).ok).toBe(false);
    expect(parseField({ label: "???", type: "string" }).ok).toBe(false);
  });
});

describe("parseRule", () => {
  it("parses a routing rule with a JSON condition", () => {
    const r = parseRule({
      label: "Damaged goes to priority",
      action_type: "route",
      target_queue: "priority_replacements",
      priority: "high",
      condition:
        '{"all":[{"field":"subcategory","op":"eq","value":"damaged"}]}',
    });
    expect(r.ok && r.value.actionType).toBe("route");
    expect(r.ok && r.value.condition).toEqual({
      all: [{ field: "subcategory", op: "eq", value: "damaged" }],
    });
  });

  it("defaults to an always-match condition", () => {
    const r = parseRule({ action_type: "auto_reply" });
    expect(r.ok && r.value.condition).toEqual({ all: [] });
  });

  it("carries the evaluation order, since first match wins", () => {
    const r = parseRule({ action_type: "auto_reply", sort_order: "3" });
    expect(r.ok && r.value.sortOrder).toBe(3);
    expect(parseRule({ action_type: "auto_reply", sort_order: "-1" })).toEqual({
      ok: false,
      error: "sort_order must be a non-negative number",
    });
  });

  it("rejects a priority outside high|normal|low", () => {
    const r = parseRule({ action_type: "auto_reply", priority: "urgent" });
    expect(r).toEqual({
      ok: false,
      error: "priority must be one of high|normal|low",
    });
  });

  it("requires a queue for route/escalate and valid JSON", () => {
    expect(parseRule({ action_type: "route" })).toEqual({
      ok: false,
      error: "route needs a target queue",
    });
    expect(
      parseRule({ action_type: "auto_reply", condition: "{oops" }).ok,
    ).toBe(false);
    expect(parseRule({ action_type: "teleport" }).ok).toBe(false);
  });
});
