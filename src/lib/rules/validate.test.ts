import { describe, expect, it } from "vitest";
import { isCondition } from "./validate";
import { parseRule } from "../config/forms";
import { evaluateCondition } from "./evaluate";
import type { Condition } from "./types";

describe("untrusted condition trees", () => {
  it("builds a valid rule from the merchant's plain-language form fields", () => {
    const rule = parseRule({
      action_type: "route",
      target_queue: "returns",
      condition_field: "reason",
      condition_op: "eq",
      condition_value: "wrong_size",
    });
    expect(rule.ok).toBe(true);
    if (rule.ok)
      expect(rule.value.condition).toEqual({
        field: "reason",
        op: "eq",
        value: "wrong_size",
      });
  });
  it.each([
    null,
    [],
    { all: "invalid" },
    { not: null },
    { all: [], any: [] },
    { field: "x", op: "wat", value: 1 },
  ])("rejects malformed trees: %j", (condition) => {
    expect(isCondition(condition)).toBe(false);
    expect(evaluateCondition(condition as Condition, { fields: {} })).toBe(
      false,
    );
    expect(
      parseRule({
        condition: JSON.stringify(condition),
        action_type: "route",
        target_queue: "returns",
      }).ok,
    ).toBe(false);
  });
  it("accepts nested comparisons and rejects excessive depth", () => {
    let node: unknown = { field: "reason", op: "in", value: ["wrong_size"] };
    expect(
      isCondition({ all: [node, { not: { field: "photo", op: "absent" } }] }),
    ).toBe(true);
    for (let n = 0; n < 20; n++) node = { not: node };
    expect(isCondition(node)).toBe(false);
  });
});
