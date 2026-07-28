import { describe, expect, it } from "vitest";
import { promptToMessage } from "./messages";
import type { Prompt } from "../intake";

const TO = "905551112233";

describe("promptToMessage", () => {
  it("renders a category prompt as an interactive List Message", () => {
    const prompt: Prompt = {
      kind: "select_category",
      retry: false,
      options: [
        { key: "return", label: "Return request" },
        {
          key: "wrong_damaged_missing",
          label: "Wrong / damaged / missing item",
        },
      ],
    };
    const msg = promptToMessage(prompt, TO);
    if (msg.type !== "interactive") throw new Error("expected interactive");
    expect(msg.interactive.type).toBe("list");
    expect(msg.interactive.action.button.length).toBeLessThanOrEqual(20);

    const rows = msg.interactive.action.sections[0].rows;
    expect(rows.map((r) => r.id)).toEqual(["return", "wrong_damaged_missing"]);
    // long label is truncated in the title but preserved in the description
    const long = rows[1];
    expect(long.title.length).toBeLessThanOrEqual(24);
    expect(long.description).toBe("Wrong / damaged / missing item");
  });

  it("offers an enum field as a tappable list, never as free text (SPEC §5)", () => {
    const prompt: Prompt = {
      kind: "select_field",
      retry: false,
      field: {
        key: "refund_method",
        type: "enum",
        required: true,
        enumValues: ["original_payment", "store_credit", "bank_transfer"],
      },
      options: [
        { key: "original_payment", label: "Original payment" },
        { key: "store_credit", label: "Store credit" },
        { key: "bank_transfer", label: "Bank transfer" },
      ],
    };
    const msg = promptToMessage(prompt, TO);
    if (msg.type !== "interactive") throw new Error("expected interactive");

    const rows = msg.interactive.action.sections[0].rows;
    // The ids are the enum values, so a tap submits a valid value directly.
    expect(rows.map((r) => r.id)).toEqual([
      "original_payment",
      "store_credit",
      "bank_transfer",
    ]);
    expect(msg.interactive.body.text).toContain("refund method");
  });

  it("asks for a normal field as text", () => {
    const prompt: Prompt = {
      kind: "request_field",
      retry: false,
      field: { key: "order_number", type: "string", required: true },
    };
    const msg = promptToMessage(prompt, TO);
    if (msg.type !== "text") throw new Error("expected text");
    expect(msg.text.body.toLowerCase()).toContain("order number");
  });

  it("asks for a photo for media fields, with a retry prefix when retrying", () => {
    const prompt: Prompt = {
      kind: "request_field",
      retry: true,
      field: { key: "photo", type: "media", required: true },
    };
    const msg = promptToMessage(prompt, TO);
    if (msg.type !== "text") throw new Error("expected text");
    expect(msg.text.body.toLowerCase()).toContain("photo");
    expect(msg.text.body.toLowerCase()).toContain("sorry");
  });

  it("summarizes a completed case", () => {
    const prompt: Prompt = {
      kind: "complete",
      case: {
        category: "return",
        subcategory: "doesnt_fit",
        integration_tier: 0,
        fields: [
          { key: "order_number", raw: "TR100432", normalized: "TR100432" },
        ],
      },
    };
    const msg = promptToMessage(prompt, TO);
    if (msg.type !== "text") throw new Error("expected text");
    expect(msg.text.body).toContain("return");
    expect(msg.text.body).toContain("TR100432");
  });
});
