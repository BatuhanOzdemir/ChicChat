/**
 * A small intake config mirroring the seeded taxonomy (a few categories), used
 * by the intake tests and as a worked example of the config shape. Not imported
 * by the app.
 */
import type { IntakeConfig } from "./types";

export const demoIntakeConfig: IntakeConfig = {
  orderIdRegex: "^[A-Z0-9]{4,}$",
  categories: [
    {
      key: "return",
      label: "Return request",
      subcategories: [
        { key: "changed_mind", label: "Changed my mind" },
        { key: "doesnt_fit", label: "Doesn't fit" },
        { key: "not_as_described", label: "Not as described" },
      ],
      fields: [
        {
          key: "order_number",
          type: "string",
          required: true,
          normalizeRule: "order_number",
        },
        { key: "item_ref", type: "ref", required: true },
        { key: "reason", type: "enum", required: true, enumValues: null },
        {
          key: "condition",
          type: "enum",
          required: true,
          enumValues: ["unworn_tags_on", "worn_tags_removed"],
        },
      ],
    },
    {
      key: "wrong_damaged_missing",
      label: "Wrong / damaged / missing item",
      subcategories: [
        { key: "damaged", label: "Damaged" },
        { key: "defective", label: "Defective" },
        { key: "item_missing", label: "Item missing from order" },
      ],
      fields: [
        {
          key: "order_number",
          type: "string",
          required: true,
          normalizeRule: "order_number",
        },
        { key: "item_ref", type: "ref", required: true },
        { key: "photo", type: "media", required: true },
        { key: "description", type: "string", required: true },
      ],
    },
    {
      key: "other",
      label: "Other / talk to a human",
      subcategories: [],
      fields: [
        { key: "description", type: "string", required: true },
        {
          key: "order_number",
          type: "string",
          required: false,
          normalizeRule: "order_number",
        },
      ],
    },
  ],
};
