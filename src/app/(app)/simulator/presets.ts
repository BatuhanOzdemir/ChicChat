import type { SimulatorInputKind } from "@/lib/simulator/protocol";

/**
 * One-click regression scenarios (SPEC §7). Answers are keyed by field so a
 * preset keeps working when the taxonomy changes the order fields are asked in
 * — the runner reads `session.pendingFieldKey` and looks the answer up.
 */
export interface Preset {
  id: string;
  label: string;
  description: string;
  greeting: string;
  category?: string;
  subcategory?: string;
  answers?: Record<string, { kind: SimulatorInputKind; value: string }>;
  /** Send the greeting twice with the same message id (duplicate delivery). */
  replayGreeting?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: "messy_order_number",
    label: "Messy order number",
    description:
      "Return / doesn't fit, with '  #tr-100 432 ' — must normalize to TR100432.",
    greeting: "merhaba",
    category: "return",
    subcategory: "doesnt_fit",
    answers: {
      order_number: { kind: "text", value: "  #tr-100 432 " },
      item_ref: { kind: "text", value: "blue slim fit shirt, size M" },
      reason: { kind: "text", value: "it doesn't fit" },
      condition: { kind: "text", value: "unworn_tags_on" },
    },
  },
  {
    id: "photo_flow",
    label: "Photo flow",
    description:
      "Damaged item — exercises the required photo field with a fake media upload.",
    greeting: "hello",
    category: "wrong_damaged_missing",
    subcategory: "damaged",
    answers: {
      order_number: { kind: "text", value: "TR100432" },
      item_ref: { kind: "text", value: "red summer dress" },
      description: { kind: "text", value: "the seam is torn along the back" },
      photo: { kind: "photo", value: "media.sim.torn-seam" },
    },
  },
  {
    id: "flow_submission",
    label: "Flow submission",
    description:
      "Answers a field via a WhatsApp Flow payload (nfm_reply) instead of typing.",
    greeting: "hi",
    category: "exchange",
    subcategory: "different_size",
    answers: {
      order_number: { kind: "text", value: "TR100999" },
      item_ref: {
        kind: "flow",
        value: '{"item_ref":"Chino Trousers — Beige / 32"}',
      },
      desired_variant: { kind: "text", value: "34" },
      reason: { kind: "text", value: "too tight" },
    },
  },
  {
    id: "duplicate_replay",
    label: "Duplicate replay",
    description:
      "Delivers the same message id twice — one effect expected (idempotency).",
    greeting: "hi",
    replayGreeting: true,
  },
];
