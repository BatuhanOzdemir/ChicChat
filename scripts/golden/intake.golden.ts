import { it } from "vitest";
import { advance, startIntake } from "@/lib/intake";
import type { IntakeConfig, IntakeSession, IntakeState } from "@/lib/intake";
import { demoIntakeConfig } from "@/lib/intake/fixtures";
import { EDGE_STRINGS, Recorder } from "./record";

function conversation(
  config: IntakeConfig,
  initial: Record<string, string>,
  messages: string[],
) {
  let session: IntakeSession = startIntake(config, initial);
  const sessions = [session];
  for (const message of messages) {
    session = advance(config, session.state, message);
    sessions.push(session);
  }
  return sessions;
}

it("records intake", () => {
  const r = new Recorder("intake");
  const kvkk: IntakeConfig = {
    ...demoIntakeConfig,
    kvkkUrl: "https://example.com/kvkk",
  };
  const strict: IntakeConfig = {
    ...demoIntakeConfig,
    orderIdRegex: "^TR\\d{6}$",
  };
  const turkish: IntakeConfig = {
    kvkkUrl: "https://example.com/kvkk",
    categories: [
      {
        key: "iade",
        label: "İade talebi",
        subcategories: [
          { key: "beden", label: "Beden uymadı" },
          { key: "ılık", label: "ILIK" },
        ],
        fields: [
          {
            key: "neden",
            type: "enum",
            required: true,
            enumValues: ["çok_büyük", "küçük", "İptal"],
          },
          { key: "foto", type: "media", required: true },
          { key: "serbest", type: "enum", required: true, enumValues: [] },
          { key: "ek", type: "string", required: false },
        ],
      },
    ],
  };
  const empty: IntakeConfig = { categories: [] };
  const scripts: [IntakeConfig, Record<string, string>, string[]][] = [
    [
      demoIntakeConfig,
      {},
      [
        "return",
        "doesnt_fit",
        "  #tr-100 432 ",
        "blue shirt",
        "Wrong_Size",
        "Unworn_Tags_On",
        "anything",
      ],
    ],
    [
      kvkk,
      {},
      [
        "pizza please",
        "2",
        "3",
        "##",
        "TR100",
        "shirt",
        "photo-id",
        "  it   broke  ",
      ],
    ],
    [
      demoIntakeConfig,
      {},
      [
        "1",
        "Doesn't fit",
        "TR100432",
        "s",
        "it doesn't fit",
        "too tight",
        "wrong_size",
        "blue",
        "WORN_TAGS_REMOVED",
      ],
    ],
    [
      demoIntakeConfig,
      { order_number: "#TR-100 432", junk: "x" },
      ["return", "changed_mind", "shirt", "other", "unworn_tags_on"],
    ],
    [demoIntakeConfig, { order_number: "##" }, ["return", "changed", "TR100"]],
    [demoIntakeConfig, {}, ["other", "", "   ", "need help"]],
    [demoIntakeConfig, {}, ["ret", "fit", "0", "4", "99", "Not As Described"]],
    [
      demoIntakeConfig,
      {},
      [
        "Wrong / damaged / missing item",
        "item missing from order",
        "tr100432",
        "x",
        "",
        "desc",
      ],
    ],
    [strict, {}, ["return", "doesnt_fit", "TR100", "tr-123456"]],
    [
      turkish,
      {},
      ["İADE TALEBİ", "ılık", "ÇOK_BÜYÜK", "İptal", "foto", "free text"],
    ],
    [turkish, {}, ["iade", "beden", "iptal", "m", "", "x"]],
    [empty, {}, ["anything", "1"]],
  ];
  for (const s of EDGE_STRINGS) {
    scripts.push([demoIntakeConfig, {}, [s, "return", s, "doesnt_fit", s, s]]);
    scripts.push([turkish, {}, ["1", "1", s, s]]);
  }
  for (const [config, initial, messages] of scripts)
    r.call("conversation", conversation, config, initial, messages);

  // Resuming stored sessions, including shapes the TypeScript wrote.
  const stored: IntakeState[] = [
    {
      status: "collecting_fields",
      categoryKey: "return",
      subcategoryKey: "doesnt_fit",
      pendingFieldKey: "order_number",
      fields: {},
      pendingInitial: {},
    },
    {
      status: "collecting_fields",
      categoryKey: "gone",
      pendingFieldKey: "x",
      fields: {},
      pendingInitial: {},
    },
    {
      status: "selecting_subcategory",
      categoryKey: "return",
      fields: {},
      pendingInitial: {},
    },
    {
      status: "complete",
      categoryKey: "other",
      fields: { description: { raw: "a", normalized: "a", valid: true } },
      pendingInitial: {},
    },
    {
      status: "collecting_fields",
      categoryKey: "other",
      pendingFieldKey: "missing",
      fields: {},
      pendingInitial: {},
    },
    {
      status: "collecting_fields",
      categoryKey: "other",
      fields: { order_number: { raw: "##", normalized: "", valid: false } },
      pendingInitial: { description: "pre" },
    },
  ];
  for (const state of stored)
    for (const message of ["TR100432", "1", "x"])
      r.call("resume", advance, demoIntakeConfig, state, message);
  r.write();
});
