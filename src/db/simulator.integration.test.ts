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
import { clientDatabase } from "./database";
import { DEMO_MERCHANT_ID } from "./config";
import { loadSession } from "./sessions";
import { forgetFakeConversations } from "./test-isolation";
import type { SimulatorInputKind } from "../lib/simulator/protocol";
import {
  runSimulatorAction,
  type SimulatorResponse,
} from "../server/simulator/service";

/**
 * Step 1 gate (SPEC §7): whole intakes complete inside the simulator, for
 * several categories, with the case JSON correct each time — and no Meta
 * credentials involved (this suite never sets or reads WHATSAPP_* env vars).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

type Answer = { kind: SimulatorInputKind; value: string };

async function send(
  phone: string,
  message: { kind: SimulatorInputKind; value: string; messageId?: string },
  injectError?: "handler_exception" | "integration_down",
): Promise<SimulatorResponse> {
  return runSimulatorAction(db, {
    action: "message",
    merchantId: DEMO_MERCHANT_ID,
    phone,
    message,
    ...(injectError ? { injectError } : {}),
  });
}

/** Walk a full intake, answering whichever field the machine asks for next. */
async function completeIntake(
  phone: string,
  category: string,
  subcategory: string,
  answers: Record<string, Answer>,
): Promise<SimulatorResponse> {
  let last = await send(phone, { kind: "text", value: "merhaba" });
  last = await send(phone, { kind: "list", value: category });
  last = await send(phone, { kind: "list", value: subcategory });

  for (let i = 0; i < 12; i++) {
    const pending = last.session?.pendingFieldKey;
    if (!pending) break;
    const answer = answers[pending];
    if (!answer) throw new Error(`no scripted answer for field "${pending}"`);
    last = await send(phone, answer);
  }
  return last;
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
  await client.query("begin");
  // A hosted database keeps what earlier runs left behind (R6b).
  await forgetFakeConversations(client);
});
afterEach(async () => {
  await client.query("rollback");
});

describe("three categories complete end-to-end in the simulator", () => {
  it("return / doesn't fit — messy order number is normalized", async () => {
    const result = await completeIntake(
      "905550000101",
      "return",
      "doesnt_fit",
      {
        order_number: { kind: "text", value: "  #tr-100 432 " },
        item_ref: { kind: "text", value: "blue slim fit shirt" },
        reason: { kind: "list", value: "wrong_size" },
        condition: { kind: "text", value: "unworn_tags_on" },
      },
    );

    expect(result.completedCase).not.toBeNull();
    expect(result.completedCase).toMatchObject({
      category: "return",
      subcategory: "doesnt_fit",
      integration_tier: 0,
      status: "open",
    });
    expect(result.completedCase?.fields.order_number).toBe("TR100432");
    expect(result.completedCase?.fields.condition).toBe("unworn_tags_on");
    // Session is cleared once the case exists.
    expect(await loadSession(db, DEMO_MERCHANT_ID, "905550000101")).toBeNull();
  });

  it("wrong/damaged/missing — photo captured as a media ref", async () => {
    const result = await completeIntake(
      "905550000102",
      "wrong_damaged_missing",
      "damaged",
      {
        order_number: { kind: "text", value: "TR100432" },
        item_ref: { kind: "text", value: "red summer dress" },
        description: { kind: "text", value: "  the seam is  torn " },
        photo: { kind: "photo", value: "media.sim.torn" },
      },
    );

    expect(result.completedCase?.category).toBe("wrong_damaged_missing");
    expect(result.completedCase?.photos).toEqual(["media.sim.torn"]);
    expect(result.completedCase?.fields.description).toBe("the seam is torn");
  });

  it("exchange — a field answered by a Flow submission", async () => {
    const result = await completeIntake(
      "905550000103",
      "exchange",
      "different_size",
      {
        order_number: { kind: "text", value: "TR100999" },
        item_ref: {
          kind: "flow",
          value: '{"item_ref":"Chino Trousers — Beige / 32"}',
        },
        desired_variant: { kind: "text", value: "34" },
        reason: { kind: "list", value: "wrong_size" },
      },
    );

    expect(result.completedCase?.category).toBe("exchange");
    expect(result.completedCase?.subcategory).toBe("different_size");
    // The Flow payload was unwrapped to the field value, not stored as JSON.
    expect(result.completedCase?.fields.item_ref).toBe(
      "Chino Trousers — Beige / 32",
    );
  });
});

describe("simulator controls", () => {
  const phone = "905550000104";

  it("presents the category list on first contact and tapping advances it", async () => {
    const first = await send(phone, { kind: "text", value: "hi" });
    const list = first.outbound[0];
    if (list.type !== "interactive") throw new Error("expected a List Message");
    expect(list.interactive.action.sections[0].rows.map((r) => r.id)).toContain(
      "return",
    );
    expect(first.session?.status).toBe("selecting_category");

    const second = await send(phone, { kind: "list", value: "return" });
    expect(second.session?.status).toBe("selecting_subcategory");
  });

  it("reset clears the session", async () => {
    await send(phone, { kind: "text", value: "hi" });
    const reset = await runSimulatorAction(db, {
      action: "reset",
      merchantId: DEMO_MERCHANT_ID,
      phone,
    });
    expect(reset.session).toBeNull();
    expect(await loadSession(db, DEMO_MERCHANT_ID, phone)).toBeNull();
  });

  it("time travel ages the live session", async () => {
    await send(phone, { kind: "text", value: "hi" });
    const before = await runSimulatorAction(db, {
      action: "state",
      merchantId: DEMO_MERCHANT_ID,
      phone,
    });
    const aged = await runSimulatorAction(db, {
      action: "time_travel",
      merchantId: DEMO_MERCHANT_ID,
      phone,
      ageMinutes: 90,
    });
    expect(aged.notice).toContain("aged by 90");
    const beforeTs = new Date(before.sessionMeta!.updated_at).getTime();
    const afterTs = new Date(aged.sessionMeta!.updated_at).getTime();
    expect(beforeTs - afterTs).toBeGreaterThanOrEqual(89 * 60_000);
  });

  it("handler_exception injection produces the generic reply (SPEC §13)", async () => {
    const result = await send(
      phone,
      { kind: "text", value: "hi" },
      "handler_exception",
    );
    expect(result.error).toContain("processing failed");

    // The customer is told something generic — never diagnostics.
    const reply = result.outbound[result.outbound.length - 1];
    if (reply.type !== "text") throw new Error("expected a text reply");
    expect(reply.text.body).toMatch(/something went wrong/i);
    expect(reply.text.body).not.toMatch(/injected|Error|stack/i);

    // …and the session is marked errored for the merchant console.
    const { rows } = await client.query(
      `select status, last_error from intake_sessions
        where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, phone],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { status: string }).status).toBe("errored");
  });

  it("integration_down injection is accepted with a notice (no connector yet)", async () => {
    const result = await send(
      phone,
      { kind: "text", value: "hi" },
      "integration_down",
    );
    expect(result.notice).toContain("integration_down");
    expect(result.error).toBeNull();
  });

  it("a duplicate delivery has no second effect (SPEC §11 idempotency)", async () => {
    const messageId = "wamid.sim.duplicate";
    const first = await send(phone, { kind: "text", value: "hi", messageId });
    expect(first.outbound).toHaveLength(1);

    const replay = await send(phone, { kind: "text", value: "hi", messageId });
    expect(replay.outbound).toEqual([]);
    expect(replay.error).toContain("duplicate");
  });

  it("a duplicate of a completing message does not create a second case", async () => {
    const dupPhone = "905550000105";
    let last = await send(dupPhone, { kind: "text", value: "hi" });
    last = await send(dupPhone, { kind: "list", value: "other" });

    // "other" has a single required field (description) — finish it, then replay.
    const finishId = "wamid.sim.finish";
    const finish = {
      kind: "text" as const,
      value: "please call me back",
      messageId: finishId,
    };
    last = await send(dupPhone, finish);
    expect(last.completedCase).not.toBeNull();

    const replay = await send(dupPhone, finish);
    expect(replay.completedCase).toBeNull();

    const { rows } = await client.query(
      `select count(*)::int as n from cases
        where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, dupPhone],
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
