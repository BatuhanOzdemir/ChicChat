import { it } from "vitest";
import {
  flowReplyValue,
  genericErrorMessage,
  inboundSummary,
  nudgeMessage,
  outboundSummary,
  parseInbound,
  promptToMessage,
} from "@/lib/whatsapp";
import { advance, startIntake } from "@/lib/intake";
import type { IntakeSession } from "@/lib/intake";
import { demoIntakeConfig } from "@/lib/intake/fixtures";
import { buildInboundEnvelope } from "@/lib/simulator/envelope";
import { parseSimulatorRequest } from "@/lib/simulator/protocol";
import { maskPhone, redactLog, redactText } from "@/lib/logging/mask";
import { gateDecision, isOpenPath, safeNextPath } from "@/lib/auth/gate";
import { activeSection } from "@/lib/nav";
import { EDGE_STRINGS, Recorder } from "./record";

function wrap(messages: unknown) {
  return {
    entry: [
      {
        changes: [{ value: { metadata: { phone_number_id: "P" }, messages } }],
      },
    ],
  };
}

it("records whatsapp, simulator, mask, gate", () => {
  const r = new Recorder("whatsapp");
  const bodies: unknown[] = [
    null,
    {},
    [],
    "x",
    5,
    { entry: null },
    { entry: {} },
    { entry: [{}] },
    { entry: [{ changes: "x" }] },
    { entry: [null] },
    { entry: [{ changes: [null] }] },
    { entry: [{ changes: [{}] }] },
    { entry: [{ changes: [{ value: null }] }] },
    wrap([null]),
    wrap(["str"]),
    wrap([{ from: "1", id: "a", type: "text", text: { body: "hi" } }]),
    wrap([{ from: 905, id: 7, type: "text", text: { body: "num ids" } }]),
    wrap([{ from: "", id: "a", type: "text", text: { body: "x" } }]),
    wrap([{ from: "1", id: "a", type: "text", text: { body: "" } }]),
    wrap([{ from: "1", id: "a", type: "text" }]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { list_reply: { id: "" } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { list_reply: { id: null }, button_reply: { id: "b" } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { button_reply: { id: "yes" } },
      },
    ]),
    wrap([{ from: "1", id: "a", type: "interactive", interactive: null }]),
    wrap([{ from: "1", id: "a", type: "interactive" }]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: '{"a":1.0}' } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: '{"a":true}' } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: '{"a":null}' } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: "[1]" } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: '{"a":1e21}' } },
      },
    ]),
    wrap([
      {
        from: "1",
        id: "a",
        type: "interactive",
        interactive: { nfm_reply: { response_json: "" } },
      },
    ]),
    wrap([{ from: "1", id: "a", type: "image", image: { id: "m" } }]),
    wrap([{ from: "1", id: "a", type: "image", image: {} }]),
    wrap([{ from: "1", id: "a", type: "audio" }]),
    {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "1",
                    id: "a",
                    type: "text",
                    text: { body: "no metadata" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    {
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: null },
                messages: [
                  { from: "1", id: "a", type: "text", text: { body: "x" } },
                ],
              },
            },
          ],
        },
      ],
    },
  ];
  for (const body of bodies) r.call("parseInbound", parseInbound, body);
  for (const s of [
    ...EDGE_STRINGS,
    '{"a":"1"}',
    '{"a":2}',
    '{"a":-0}',
    '{"a":0.1}',
    '{"a":[1]}',
    '{"a":{}}',
    '{"a":"1","b":2}',
    "{}",
    "null",
    "1",
    '"str"',
    '{"a":NaN}',
  ])
    r.call("flowReplyValue", flowReplyValue, s);

  // Every prompt the demo conversations produce, in both locales.
  const sessions: IntakeSession[] = [];
  const kvkk = { ...demoIntakeConfig, kvkkUrl: "https://example.com/kvkk" };
  let s = startIntake(kvkk);
  sessions.push(s);
  for (const m of [
    "x",
    "return",
    "y",
    "doesnt_fit",
    "##",
    "TR100",
    "shirt",
    "bad",
    "wrong_size",
    "unworn_tags_on",
  ]) {
    s = advance(kvkk, s.state, m);
    sessions.push(s);
  }
  s = startIntake(demoIntakeConfig);
  for (const m of ["2", "1", "TR1000", "item", "photo", "desc"]) {
    s = advance(demoIntakeConfig, s.state, m);
    sessions.push(s);
  }
  const extra = [
    {
      kind: "select_category",
      retry: false,
      options: EDGE_STRINGS.map((label, i) => ({ key: `k${i}`, label })),
    },
    {
      kind: "select_field",
      retry: true,
      field: {
        key: "size_choice",
        type: "enum",
        required: true,
        label: "Beden 👗",
      },
      options: [{ key: "a", label: "👗".repeat(20) }],
    },
    {
      kind: "request_field",
      retry: true,
      field: { key: "x", type: "string", required: true, label: null },
    },
    {
      kind: "complete",
      case: {
        category: "c",
        subcategory: "",
        integration_tier: 0,
        fields: [{ key: "a_b", raw: "r", normalized: null }],
      },
    },
  ];
  for (const locale of ["en", "tr", "tr-TR", "de"]) {
    for (const session of sessions)
      r.call(
        "promptToMessage",
        promptToMessage,
        session.prompt,
        "905551112233",
        locale,
      );
    for (const prompt of extra)
      r.call("promptToMessage", promptToMessage, prompt as never, "9", locale);
    r.call("nudgeMessage", nudgeMessage, "9", locale);
    r.call("genericErrorMessage", genericErrorMessage, "9", locale);
  }
  for (const session of sessions)
    r.call(
      "outboundSummary",
      outboundSummary,
      promptToMessage(session.prompt, "9"),
    );
  for (const body of bodies.slice(15))
    for (const m of parseInbound(body))
      r.call("inboundSummary", inboundSummary, m);

  for (const kind of ["text", "list", "photo", "flow"])
    for (const value of ["hi", '{"item_ref":"Navy"}', "İade"]) {
      const env = buildInboundEnvelope(
        { kind: kind as never, value },
        { phoneNumberId: "SIM", from: "905", messageId: "w1" },
      );
      r.call(
        "buildInboundEnvelope",
        buildInboundEnvelope,
        { kind, value },
        { phoneNumberId: "SIM", from: "905", messageId: "w1" },
      );
      r.call("parseInbound", parseInbound, env);
    }
  const base = { merchantId: "m1", phone: "905551112233" };
  const requests: unknown[] = [
    null,
    [],
    "x",
    {},
    { ...base, action: "state" },
    { ...base, action: " state " },
    { ...base, action: "nope" },
    { ...base, merchantId: " " },
    { ...base, phone: "+90 (555) 1" },
    { ...base, phone: "12345", action: "state" },
    { ...base, phone: "٠١٢٣٤٥٦٧", action: "state" },
    { ...base, action: "state", injectError: "explode" },
    { ...base, action: "state", injectError: "" },
    { ...base, action: "state", injectError: "delivery_failure" },
    { ...base, action: "message" },
    { ...base, action: "message", message: null },
    { ...base, action: "message", message: { kind: "text", value: " " } },
    { ...base, action: "message", message: { kind: "video", value: "x" } },
    {
      ...base,
      action: "message",
      message: { kind: "photo", value: "m", messageId: " " },
    },
    {
      ...base,
      action: "message",
      message: { kind: "flow", value: "{}", messageId: "w.dup" },
    },
    { ...base, action: "time_travel" },
    { ...base, action: "time_travel", ageMinutes: "5" },
    { ...base, action: "time_travel", ageMinutes: 5.9 },
    { ...base, action: "time_travel", ageMinutes: -1 },
    { ...base, action: "time_travel", ageMinutes: true },
    { ...base, action: "time_travel", ageMinutes: 1e400 },
    {
      ...base,
      action: "retry_delivery",
      message: { kind: "text", value: "ignored" },
    },
  ];
  for (const body of requests)
    r.call("parseSimulatorRequest", parseSimulatorRequest, body);

  for (const s2 of [
    ...EDGE_STRINGS,
    "905352680403",
    "+90 535 268 04 03",
    "12",
    "٠٥٥٥١٢٣٤٥٦٧",
  ]) {
    r.call("maskPhone", maskPhone, s2);
    r.call("redactText", redactText, s2);
  }
  for (const t of [
    "Bearer abc.def ghi",
    "bearer   xyz,",
    "password=hunter2&x=1",
    'secret: "s3cr3t"',
    "access_token=abc}",
    "postgresql://u:p@host:5432/db",
    "call +90 555 123 45 67 now",
    "id 00000000-0000-0000-0000-000000000001",
    "at 2026-09-09T12:00:00.000Z",
    "order 123456 and 1234567",
    "(555) 123-4567",
    "Authorization: Basic xyz",
    "phone 905550001234 secret=x Bearer t",
    "1.234.567.890",
  ])
    r.call("redactText", redactText, t);
  r.call("redactLog", redactLog, {
    a: {
      password: "x",
      token2: "y",
      Cookie: "z",
      list: ["905550001234", 1, null, true],
    },
    n: 5,
  });
  let deep: unknown = "905550001234";
  for (let i = 0; i < 12; i++) deep = { d: deep };
  r.call("redactLog", redactLog, deep);
  r.call(
    "redactLog",
    redactLog,
    Array.from({ length: 150 }, (_, i) => i),
  );

  for (const p of [
    "/",
    "/login",
    "/login/",
    "/login-x",
    "/api/health",
    "/api/health/x",
    "/_next/static/a.js",
    "/_next",
    "/favicon.ico",
    "/cases",
  ]) {
    r.call("isOpenPath", isOpenPath, p);
    for (const auth of [true, false])
      for (const prod of [true, false])
        r.call("gateDecision", gateDecision, {
          pathname: p,
          authenticated: auth,
          isProduction: prod,
          allowDevelopmentAccess: true,
        });
  }
  for (const n of [
    "/cases",
    "/console/abc?x=1&y=%20",
    "//evil",
    "https://x",
    "",
    "/a b",
    "/ç",
    "/cases\n",
    "/[id]",
    "\\x",
  ])
    r.call("safeNextPath", safeNextPath, n);
  for (const p of [
    "/",
    "/console",
    "/console/",
    "/consoles",
    "/cases/x/y",
    "/config",
    "/simulator/a",
  ])
    r.call("activeSection", activeSection, p);
  r.write();
});
