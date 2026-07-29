import { describe, expect, it } from "vitest";
import {
  decideRouting,
  describeRouting,
  routingContext,
  type LabelledRule,
} from "./routing";

/**
 * These mirror the default rules the seed installs (SPEC §3), because the
 * question this file has to answer is the Step 5 gate's: does a case land in
 * the queue the merchant's rules say it should?
 */
const DAMAGED_WITH_PHOTO: LabelledRule = {
  id: "r1",
  label: "damaged with photo",
  condition: {
    all: [
      { field: "subcategory", op: "in", value: ["damaged", "defective"] },
      { field: "photo", op: "present" },
    ],
  },
  action_type: "route",
  target_queue: "priority_replacements",
  priority: "high",
};

const NO_PHOTO: LabelledRule = {
  id: "r2",
  label: "photo missing",
  condition: { all: [{ field: "photo", op: "absent" }] },
  action_type: "request_info",
  target_queue: null,
  priority: "normal",
};

const ITEM_MISSING: LabelledRule = {
  id: "r3",
  label: "item missing",
  condition: {
    all: [{ field: "subcategory", op: "eq", value: "item_missing" }],
  },
  action_type: "escalate",
  target_queue: "verify_order_contents",
  priority: "normal",
};

const RULES = [DAMAGED_WITH_PHOTO, NO_PHOTO, ITEM_MISSING];

function context(
  subcategory: string,
  fields: { key: string; raw: string; normalized: string | null }[] = [],
) {
  return routingContext({
    category: "wrong_damaged_missing",
    subcategory,
    fields,
  });
}

describe("decideRouting (SPEC §3 → §9)", () => {
  it("routes a damaged item with a photo to the priority queue", () => {
    const decision = decideRouting(
      RULES,
      context("damaged", [
        { key: "photo", raw: "media.1", normalized: "media.1" },
      ]),
    );
    expect(decision).toMatchObject({
      queue: "priority_replacements",
      priority: "high",
      status: "open",
    });
    expect(decision.matched.map((m) => m.label)).toEqual([
      "damaged with photo",
    ]);
  });

  it("asks for more information when the photo is missing", () => {
    const decision = decideRouting(RULES, context("damaged"));
    expect(decision).toMatchObject({
      queue: null,
      priority: "normal",
      status: "needs_info",
    });
  });

  it("escalates a missing item to the verification queue", () => {
    const decision = decideRouting(
      RULES,
      context("item_missing", [
        { key: "photo", raw: "media.2", normalized: "media.2" },
      ]),
    );
    expect(decision).toMatchObject({
      queue: "verify_order_contents",
      status: "escalated",
    });
  });

  it("gives the first matching rule the decision, and reports the rest", () => {
    // No photo *and* item_missing: rule 2 comes first, rule 3 also matches.
    const decision = decideRouting(RULES, context("item_missing"));
    expect(decision.status).toBe("needs_info");
    expect(decision.queue).toBeNull();
    expect(decision.matched.map((m) => m.label)).toEqual([
      "photo missing",
      "item missing",
    ]);
  });

  it("leaves a case open and unrouted when nothing matches", () => {
    const decision = decideRouting(
      [ITEM_MISSING],
      context("wrong_item", [
        { key: "photo", raw: "media.3", normalized: "media.3" },
      ]),
    );
    expect(decision).toEqual({
      queue: null,
      priority: "normal",
      status: "open",
      matched: [],
    });
  });

  it("does not match rules about computed fields in Tier 0 (SPEC §2)", () => {
    const windowRule: LabelledRule = {
      label: "outside the return window",
      condition: {
        all: [{ field: "within_return_window", op: "eq", value: false }],
      },
      action_type: "escalate",
      target_queue: "policy_exception",
      priority: "normal",
    };
    // No integration has supplied `within_return_window`, so the case still
    // forms — it just routes with less context rather than mis-routing.
    const decision = decideRouting([windowRule], context("doesnt_fit"));
    expect(decision.queue).toBeNull();
    expect(decision.status).toBe("open");
  });

  it("degrades a mistyped priority instead of propagating it", () => {
    const decision = decideRouting(
      [{ ...ITEM_MISSING, priority: "URGENT!" }],
      context("item_missing"),
    );
    expect(decision.priority).toBe("normal");
  });

  it("treats a blank target queue as unrouted", () => {
    const decision = decideRouting(
      [{ ...ITEM_MISSING, target_queue: "   " }],
      context("item_missing"),
    );
    expect(decision.queue).toBeNull();
  });

  it("labels an unnamed rule by its position", () => {
    const decision = decideRouting(
      [{ ...ITEM_MISSING, label: null }],
      context("item_missing"),
    );
    expect(decision.matched[0].label).toBe("rule 1");
  });
});

describe("routingContext", () => {
  it("exposes the category, subcategory and normalized field values", () => {
    const ctx = routingContext({
      category: "return",
      subcategory: "doesnt_fit",
      fields: [
        { key: "order_number", raw: "#tr-100 432", normalized: "TR100432" },
      ],
    });
    expect(ctx.fields).toMatchObject({
      category: "return",
      subcategory: "doesnt_fit",
      order_number: "TR100432",
    });
  });

  it("falls back to the raw value when normalization produced nothing", () => {
    const ctx = routingContext({
      category: "return",
      subcategory: null,
      fields: [{ key: "reason", raw: "too big", normalized: null }],
    });
    expect(ctx.fields.reason).toBe("too big");
  });

  it("passes merchant settings through for rules that use `ref`", () => {
    const ctx = routingContext({
      category: "return",
      subcategory: null,
      fields: [],
      settings: { return_window_days: 30 },
    });
    expect(ctx.config).toEqual({ return_window_days: 30 });
  });
});

describe("describeRouting", () => {
  it("explains a decision in one line for the timeline", () => {
    const decision = decideRouting(
      RULES,
      context("damaged", [
        { key: "photo", raw: "media.1", normalized: "media.1" },
      ]),
    );
    expect(describeRouting(decision)).toBe(
      "Routed to priority_replacements (high priority, open) — matched damaged with photo",
    );
  });

  it("says so when no rule matched", () => {
    const decision = decideRouting([], context("damaged"));
    expect(describeRouting(decision)).toContain("unrouted");
    expect(describeRouting(decision)).toContain("no rule matched");
  });
});
