import { describe, expect, it } from "vitest";
import { advance, startIntake } from "./machine";
import { demoIntakeConfig as config } from "./fixtures";
import type { IntakeSession } from "./types";

describe("KVKK disclosure (SPEC §12)", () => {
  const withKvkk = { ...config, kvkkUrl: "https://example.com/kvkk" };

  it("discloses on the opening message of a new conversation", () => {
    const start = startIntake(withKvkk);
    expect(start.prompt).toMatchObject({
      kind: "select_category",
      disclosure: "https://example.com/kvkk",
    });
  });

  it("does not repeat it when the machine re-asks", () => {
    const start = startIntake(withKvkk);
    // Unrecognized input sends the customer back to the category list; that is
    // a recovery, not a new conversation.
    const retry = advance(withKvkk, start.state, "pizza please");
    expect(retry.prompt).toMatchObject({ kind: "select_category", retry: true });
    expect(
      (retry.prompt as { disclosure?: string }).disclosure,
    ).toBeUndefined();
  });

  it("says nothing when the merchant has configured no URL", () => {
    const start = startIntake(config);
    expect(
      (start.prompt as { disclosure?: string }).disclosure,
    ).toBeUndefined();
  });
});

describe("intake machine — selection", () => {
  it("re-prompts on an unrecognized category selection", () => {
    const start = startIntake(config);
    expect(start.prompt.kind).toBe("select_category");

    const next = advance(config, start.state, "pizza please");
    expect(next.prompt).toMatchObject({ kind: "select_category", retry: true });
  });

  it("walks category -> subcategory -> first required field", () => {
    let s: IntakeSession = startIntake(config);
    s = advance(config, s.state, "return");
    expect(s.prompt).toMatchObject({
      kind: "select_subcategory",
      category: "return",
    });
    s = advance(config, s.state, "doesnt_fit");
    expect(s.prompt).toMatchObject({
      kind: "request_field",
      field: { key: "order_number" },
      retry: false,
    });
  });
});

describe("intake machine — recovers when the taxonomy changes mid-session", () => {
  it("asks for a category again instead of throwing when the selected one disappears", () => {
    let s: IntakeSession = startIntake(config);
    s = advance(config, s.state, "return");
    s = advance(config, s.state, "doesnt_fit"); // now collecting fields

    // The merchant disables/renames the category while the customer is mid-intake.
    const shrunk = {
      ...config,
      categories: config.categories.filter((c) => c.key !== "return"),
    };
    const recovered = advance(shrunk, s.state, "TR100432");
    expect(recovered.prompt).toMatchObject({
      kind: "select_category",
      retry: true,
    });
    expect(recovered.state.status).toBe("selecting_category");
    expect(recovered.state.categoryKey).toBeUndefined();
  });
});

describe("intake machine — invalid field input is re-asked", () => {
  function toOrderNumberPrompt(): IntakeSession {
    let s: IntakeSession = startIntake(config);
    s = advance(config, s.state, "return");
    s = advance(config, s.state, "doesnt_fit");
    return s; // waiting on order_number
  }

  it("re-asks the same field when the order number is invalid, then advances", () => {
    let s = toOrderNumberPrompt();
    s = advance(config, s.state, "##"); // normalizes to "" -> invalid
    expect(s.prompt).toMatchObject({
      kind: "request_field",
      field: { key: "order_number" },
      retry: true,
    });
    s = advance(config, s.state, "TR100"); // valid (>=4 alnum)
    expect(s.prompt).toMatchObject({
      kind: "request_field",
      field: { key: "item_ref" },
    });
  });

  it("offers an enum field as options and re-asks on a value outside the set", () => {
    let s = toOrderNumberPrompt();
    s = advance(config, s.state, "TR100"); // order_number
    s = advance(config, s.state, "blue shirt"); // item_ref

    // `reason` carries values, so it is a list too — it used to have none and
    // silently degraded to a free-text question, storing whatever was typed.
    expect(s.prompt).toMatchObject({
      kind: "select_field",
      field: { key: "reason" },
    });
    s = advance(config, s.state, "changed_mind");

    // `condition` has configured values, so it is offered as a list (SPEC §5).
    expect(s.prompt).toMatchObject({
      kind: "select_field",
      field: { key: "condition" },
      options: [
        { key: "unworn_tags_on", label: "Unworn tags on" },
        { key: "worn_tags_removed", label: "Worn tags removed" },
      ],
    });

    s = advance(config, s.state, "blue"); // not an allowed condition
    expect(s.prompt).toMatchObject({
      kind: "select_field",
      field: { key: "condition" },
      retry: true,
    });

    s = advance(config, s.state, "Worn_Tags_Removed"); // canonicalized
    expect(s.prompt.kind).toBe("complete");
  });
});
