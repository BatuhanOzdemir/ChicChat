import { describe, expect, it } from "vitest";
import { simulateIntake } from "./simulator";
import { demoIntakeConfig as config } from "./fixtures";
import type { IntakeCase } from "./types";

function normalized(c: IntakeCase, key: string): string | null | undefined {
  return c.fields.find((f) => f.key === key)?.normalized;
}

describe("simulateIntake — Tier-0 return with messy inputs", () => {
  const result = simulateIntake(config, {
    category: "return",
    subcategory: "doesnt_fit",
    fields: {
      order_number: "  #tr-100 432 ",
      item_ref: "the blue slim shirt",
      reason: "Wrong_Size",
      condition: "Unworn_Tags_On",
    },
  });

  it("assembles a complete, normalized structured case", () => {
    expect(result.case).toBeDefined();
    const c = result.case!;
    expect(c.category).toBe("return");
    expect(c.subcategory).toBe("doesnt_fit");
    expect(c.integration_tier).toBe(0);
    expect(normalized(c, "order_number")).toBe("TR100432");
    expect(normalized(c, "item_ref")).toBe("the blue slim shirt");
    expect(normalized(c, "condition")).toBe("unworn_tags_on");
    // `reason` is an enum now, so a tap is canonicalized like any other (SPEC §5).
    expect(normalized(c, "reason")).toBe("wrong_size");
  });

  it("asks for each required field exactly once, in order", () => {
    expect(result.asked).toEqual([
      "order_number",
      "item_ref",
      "reason",
      "condition",
    ]);
  });
});

describe("simulateIntake — list selection by index and label", () => {
  it("accepts a 1-based index for the category and a label for the subcategory", () => {
    const result = simulateIntake(config, {
      category: "1", // -> return
      subcategory: "Doesn't fit",
      fields: {
        order_number: "TR100432",
        item_ref: "shirt",
        reason: "wrong_size",
        condition: "unworn_tags_on",
      },
    });
    expect(result.case?.category).toBe("return");
    expect(result.case?.subcategory).toBe("doesnt_fit");
  });
});

describe("simulateIntake — asks only for the gaps (§0.4)", () => {
  it("does not ask for a field a classifier already extracted", () => {
    const result = simulateIntake(config, {
      category: "return",
      subcategory: "changed_mind",
      initialFields: { order_number: "#TR-100 432" },
      fields: {
        item_ref: "blue shirt",
        reason: "changed_mind",
        condition: "unworn_tags_on",
      },
    });
    expect(result.asked).not.toContain("order_number");
    expect(result.case).toBeDefined();
    expect(normalized(result.case!, "order_number")).toBe("TR100432");
  });

  it("never asks for optional fields (order_number is optional under 'other')", () => {
    const result = simulateIntake(config, {
      category: "other",
      fields: { description: "  need   help  please " },
    });
    expect(result.asked).toEqual(["description"]);
    expect(result.case?.subcategory).toBeNull();
    expect(normalized(result.case!, "description")).toBe("need help please");
    expect(normalized(result.case!, "order_number")).toBeUndefined();
  });
});
