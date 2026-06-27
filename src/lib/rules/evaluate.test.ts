import { describe, expect, it } from "vitest";
import { evaluate, evaluateCondition, evaluateRules } from "./evaluate";
import type { Rule } from "./types";

// Rules mirror the Step 2 seed defaults for the relevant categories.

const refundPastSla: Rule = {
  condition: {
    all: [
      { field: "refund_status", op: "eq", value: "received" },
      { field: "days_since_return_received", op: "gt", ref: "refund_sla_days" },
    ],
  },
  action_type: "route",
  target_queue: "finance_refunds_queue",
  priority: "high",
};

const refundWithinSla: Rule = {
  condition: {
    all: [
      { field: "refund_status", op: "eq", value: "received" },
      {
        field: "days_since_return_received",
        op: "lte",
        ref: "refund_sla_days",
      },
    ],
  },
  action_type: "auto_reply",
  target_queue: null,
  priority: "normal",
};

const notAsDescribedNeedsPhoto: Rule = {
  condition: {
    all: [{ field: "subcategory", op: "eq", value: "not_as_described" }],
  },
  action_type: "request_info",
  target_queue: null,
  priority: "normal",
};

const photoAbsentNeedsPhoto: Rule = {
  condition: { all: [{ field: "photo", op: "absent" }] },
  action_type: "request_info",
  target_queue: null,
  priority: "normal",
};

const damagedWithPhoto: Rule = {
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

const withinWindowRoute: Rule = {
  condition: {
    all: [{ field: "within_return_window", op: "eq", value: true }],
  },
  action_type: "route",
  target_queue: "returns_queue",
  priority: "normal",
};

const outsideWindowEscalate: Rule = {
  condition: {
    all: [{ field: "within_return_window", op: "eq", value: false }],
  },
  action_type: "escalate",
  target_queue: "policy_exception",
  priority: "normal",
};

describe("refund not received (SPEC §3 example)", () => {
  const config = { refund_sla_days: 14 };

  it("routes to the finance queue (high) when refund received and past SLA", () => {
    const action = evaluate(refundPastSla, {
      fields: { refund_status: "received", days_since_return_received: 20 },
      config,
    });
    expect(action).toEqual({
      action_type: "route",
      target_queue: "finance_refunds_queue",
      priority: "high",
      auto_resolve: false,
    });
  });

  it("does not fire the past-SLA rule while still within SLA", () => {
    const ctx = {
      fields: { refund_status: "received", days_since_return_received: 5 },
      config,
    };
    expect(evaluate(refundPastSla, ctx)).toBeNull();
    // ...the within-SLA auto-reply rule fires instead.
    expect(evaluate(refundWithinSla, ctx)?.action_type).toBe("auto_reply");
  });

  it("does not fire when the refund status is unknown (no integration)", () => {
    expect(
      evaluate(refundPastSla, {
        fields: { days_since_return_received: 20 },
        config,
      }),
    ).toBeNull();
  });
});

describe('require photo for "not as described" / "damaged"', () => {
  it("requests info for a not-as-described return", () => {
    expect(
      evaluate(notAsDescribedNeedsPhoto, {
        fields: { subcategory: "not_as_described" },
      })?.action_type,
    ).toBe("request_info");
  });

  it("requests a photo for a damaged item when none is attached", () => {
    expect(
      evaluate(photoAbsentNeedsPhoto, { fields: { subcategory: "damaged" } })
        ?.action_type,
    ).toBe("request_info");
  });

  it("pre-approves replacement (priority) once a photo is attached", () => {
    const action = evaluate(damagedWithPhoto, {
      fields: { subcategory: "damaged", photo: "wamid.media.123" },
    });
    expect(action).toMatchObject({
      action_type: "route",
      target_queue: "priority_replacements",
      priority: "high",
    });
  });
});

describe("within-window routing", () => {
  it("routes within-window returns and escalates out-of-window ones", () => {
    const within = { fields: { within_return_window: true } };
    const outside = { fields: { within_return_window: false } };
    expect(evaluate(withinWindowRoute, within)?.target_queue).toBe(
      "returns_queue",
    );
    expect(evaluate(withinWindowRoute, outside)).toBeNull();
    expect(evaluate(outsideWindowEscalate, outside)?.target_queue).toBe(
      "policy_exception",
    );
  });
});

describe("evaluateCondition / evaluateRules", () => {
  it("treats an empty `all` group as always-match (default rules)", () => {
    expect(evaluateCondition({ all: [] }, { fields: {} })).toBe(true);
  });

  it("collects the actions of every matching rule in order", () => {
    const actions = evaluateRules([refundPastSla, refundWithinSla], {
      fields: { refund_status: "received", days_since_return_received: 20 },
      config: { refund_sla_days: 14 },
    });
    expect(actions.map((a) => a.action_type)).toEqual(["route"]);
  });
});
