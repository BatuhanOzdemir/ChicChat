import { execFileSync } from "node:child_process";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Client } from "pg";
import { buildHandoff } from "./cases";
import { clientDatabase } from "./database";
import { DEMO_MERCHANT_ID } from "./config";
import { loadSession } from "./sessions";
import { forgetFakeConversations } from "./test-isolation";
import { handleInbound } from "../server/whatsapp/handler";
import type { InboundMessage, OutboundMessage } from "../lib/whatsapp";

/**
 * Step 8 local gate: a simulated inbound WhatsApp conversation, driven through
 * the handler against the live DB, produces the right List Messages and a
 * completed Tier-0 case. (The real Meta transport is exercised separately, live.)
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);
const FROM = "905550000009";

const sent: OutboundMessage[] = [];
const deps = {
  db,
  send: async (message: OutboundMessage) => {
    sent.push(message);
  },
};

// Every real delivery has its own id; reusing one would (correctly) be skipped
// as a duplicate now that processing is idempotent (SPEC §11).
let messageCounter = 0;

function inbound(
  kind: InboundMessage["kind"],
  reply: string,
  mediaId?: string,
): InboundMessage {
  return {
    phoneNumberId: "PNID",
    from: FROM,
    messageId: `wamid.test.${++messageCounter}`,
    kind,
    reply,
    mediaId,
  };
}

beforeAll(async () => {
  await client.connect();
  execFileSync("node", ["scripts/seed.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}, 60_000);

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  sent.length = 0;
  await client.query("begin");
  // A hosted database keeps what earlier runs left behind (R6b).
  await forgetFakeConversations(client);
});
afterEach(async () => {
  await client.query("rollback");
});

describe("inbound WhatsApp conversation -> Tier-0 case", () => {
  it("walks lists + fields and persists the case, then clears the session", async () => {
    // 1. greeting -> category List Message
    await handleInbound(deps, DEMO_MERCHANT_ID, inbound("text", "hi"));
    const categoryMsg = sent[0];
    if (categoryMsg.type !== "interactive") throw new Error("expected list");
    expect(
      categoryMsg.interactive.action.sections[0].rows.map((r) => r.id),
    ).toContain("wrong_damaged_missing");

    // 2. pick category -> subcategory List Message
    await handleInbound(
      deps,
      DEMO_MERCHANT_ID,
      inbound("interactive", "wrong_damaged_missing"),
    );
    const subMsg = sent[1];
    if (subMsg.type !== "interactive") throw new Error("expected list");
    expect(
      subMsg.interactive.action.sections[0].rows.map((r) => r.id),
    ).toContain("damaged");

    // 3. pick subcategory -> starts asking for required fields
    await handleInbound(
      deps,
      DEMO_MERCHANT_ID,
      inbound("interactive", "damaged"),
    );
    expect(sent[2]).toMatchObject({ type: "text" });

    // 4-7. Answer whichever field is asked next, so the test does not depend on
    // the merchant's configured field order (it is editable — SPEC §8).
    const answers: Record<
      string,
      { kind: InboundMessage["kind"]; value: string }
    > = {
      order_number: { kind: "text", value: "#tr-100 432" },
      item_ref: { kind: "text", value: "the red dress" },
      description: { kind: "text", value: "the seam is torn" },
      photo: { kind: "image", value: "wamid.media.9" },
    };
    for (let i = 0; i < 6; i++) {
      const pending = (await loadSession(db, DEMO_MERCHANT_ID, FROM))
        ?.pendingFieldKey;
      if (!pending) break;
      const answer = answers[pending];
      if (!answer) throw new Error(`no answer scripted for "${pending}"`);
      await handleInbound(
        deps,
        DEMO_MERCHANT_ID,
        inbound(
          answer.kind,
          answer.value,
          answer.kind === "image" ? answer.value : undefined,
        ),
      );
    }

    // Final reply is the completion summary.
    const summary = sent[sent.length - 1];
    if (summary.type !== "text") throw new Error("expected text summary");
    expect(summary.text.body).toContain("wrong_damaged_missing");
    expect(summary.text.body).toContain("TR100432");

    // A case was persisted and reads back correctly.
    const { rows } = await client.query(
      `select id from cases where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, FROM],
    );
    expect(rows).toHaveLength(1);
    const caseId = (rows[0] as { id: string }).id;

    const handoff = await buildHandoff(db, caseId);
    expect(handoff.category).toBe("wrong_damaged_missing");
    expect(handoff.subcategory).toBe("damaged");
    expect(handoff.fields.order_number).toBe("TR100432");
    expect(handoff.photos).toEqual(["wamid.media.9"]);

    // Session cleared after completion.
    expect(await loadSession(db, DEMO_MERCHANT_ID, FROM)).toBeNull();
  });

  it("re-prompts the category list when the first pick is unrecognized", async () => {
    await handleInbound(deps, DEMO_MERCHANT_ID, inbound("text", "hello"));
    await handleInbound(
      deps,
      DEMO_MERCHANT_ID,
      inbound("text", "not a category"),
    );
    const reprompt = sent[sent.length - 1];
    if (reprompt.type !== "interactive") throw new Error("expected list");
    // still on the category selection (with a retry nudge in the body)
    expect(reprompt.interactive.body.text.toLowerCase()).toContain(
      "didn't catch",
    );
  });
});
