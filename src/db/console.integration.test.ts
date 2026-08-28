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
import {
  addCaseNote,
  getCaseWorkflow,
  listCaseEvents,
  listQueue,
  listQueues,
  transitionCase,
  type QueueFilters,
} from "./console";
import { listTranscript } from "./transcript";
import { forgetFakeConversations } from "./test-isolation";
import { runSimulatorAction } from "../server/simulator/service";
import type { SimulatorInputKind } from "../lib/simulator/protocol";

/**
 * Step 5 gate (SPEC §9): a case generated in the simulator lands in the queue
 * its routing rules dictate, and then flows open → in_progress → resolved with
 * a note — with the transcript and the audit trail an agent needs.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

function filters(overrides: Partial<QueueFilters> = {}): QueueFilters {
  return { queue: null, categoryKey: null, status: null, ...overrides };
}

async function say(
  phone: string,
  kind: SimulatorInputKind,
  value: string,
  injectError?: "handler_exception",
) {
  return runSimulatorAction(db, {
    action: "message",
    merchantId: DEMO_MERCHANT_ID,
    phone,
    message: { kind, value },
    ...(injectError ? { injectError } : {}),
  });
}

/** Complete an intake in the simulator, answering whatever is asked. */
async function completeIntake(
  phone: string,
  category: string,
  subcategory: string,
  answers: Record<string, { kind: SimulatorInputKind; value: string }>,
) {
  await say(phone, "text", "merhaba");
  await say(phone, "list", category);
  let last = await say(phone, "list", subcategory);
  for (let i = 0; i < 12; i++) {
    const pending = last.session?.pendingFieldKey;
    if (!pending) break;
    const answer = answers[pending];
    if (!answer) throw new Error(`no answer for "${pending}"`);
    last = await say(phone, answer.kind, answer.value);
  }
  return last;
}

const DAMAGE_ANSWERS = {
  order_number: { kind: "text" as const, value: "#tr-100 432" },
  item_ref: { kind: "text" as const, value: "red dress" },
  description: { kind: "text" as const, value: "seam torn" },
  photo: { kind: "photo" as const, value: "media.sim.torn" },
};

const RETURN_ANSWERS = {
  order_number: { kind: "text" as const, value: "#tr-555 555" },
  item_ref: { kind: "text" as const, value: "blue shirt" },
  reason: { kind: "list" as const, value: "wrong_size" },
  condition: { kind: "list" as const, value: "unworn_tags_on" },
};

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

describe("routing rules land cases in the right queues (SPEC §3 → §9)", () => {
  it("routes a damaged item with a photo to priority_replacements at high priority", async () => {
    const done = await completeIntake(
      "905550000601",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );

    // The handoff package carries the routing flags an agent sees first.
    expect(done.completedCase).toMatchObject({
      queue: "priority_replacements",
      priority: "high",
      status: "open",
    });

    // …and the decision itself is part of the case's history.
    const events = await listCaseEvents(
      db,
      DEMO_MERCHANT_ID,
      done.completedCase!.case_id,
    );
    const routing = events.find((e) => e.kind === "routing");
    expect(routing?.body).toContain("priority_replacements");
    expect(routing?.actor).toBe("system");
    // The seed's first rule for this category is the one that decided, which
    // only holds if rule precedence follows sort_order rather than insertion
    // order (rules seeded in one transaction share a created_at).
    expect(routing?.body).toContain("rule 1");
  });

  it("escalates a missing item to verify_order_contents", async () => {
    const done = await completeIntake(
      "905550000602",
      "wrong_damaged_missing",
      "item_missing",
      DAMAGE_ANSWERS,
    );
    expect(done.completedCase).toMatchObject({
      queue: "verify_order_contents",
      status: "escalated",
      priority: "normal",
    });
  });

  it("leaves a case unrouted when no rule matches, and still queues it", async () => {
    const done = await completeIntake(
      "905550000603",
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );
    // The default return rules key off `within_return_window`, which no
    // integration supplies in Tier 0 (SPEC §2), so nothing matches.
    expect(done.completedCase).toMatchObject({
      queue: null,
      priority: "normal",
      status: "open",
    });

    const unrouted = await listQueue(
      db,
      DEMO_MERCHANT_ID,
      filters({ queue: "unrouted" }),
    );
    expect(unrouted.some((r) => r.id === done.completedCase!.case_id)).toBe(
      true,
    );
  });

  it("sorts the queue by priority, then by how long it has waited", async () => {
    const high = await completeIntake(
      "905550000604",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );
    const normal = await completeIntake(
      "905550000605",
      "wrong_damaged_missing",
      "item_missing",
      DAMAGE_ANSWERS,
    );

    const rows = await listQueue(
      db,
      DEMO_MERCHANT_ID,
      filters({ categoryKey: "wrong_damaged_missing" }),
    );
    const highIndex = rows.findIndex(
      (r) => r.id === high.completedCase!.case_id,
    );
    const normalIndex = rows.findIndex(
      (r) => r.id === normal.completedCase!.case_id,
    );
    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(highIndex).toBeLessThan(normalIndex);
  });

  it("summarizes the queues with their outstanding and high-priority counts", async () => {
    await completeIntake(
      "905550000606",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );
    const queues = await listQueues(db, DEMO_MERCHANT_ID);
    const priority = queues.find((q) => q.queue === "priority_replacements");
    expect(priority).toBeDefined();
    expect(priority!.n).toBeGreaterThan(0);
    expect(priority!.high).toBeGreaterThan(0);
  });
});

describe("an agent works a case (SPEC §9)", () => {
  it("flows open → in_progress → resolved with a note, and records each step", async () => {
    const done = await completeIntake(
      "905550000607",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );
    const caseId = done.completedCase!.case_id;

    const started = await transitionCase(
      db,
      DEMO_MERCHANT_ID,
      caseId,
      "in_progress",
    );
    expect(started).toEqual({
      ok: true,
      value: { from: "open", to: "in_progress" },
    });

    expect(
      await addCaseNote(db, DEMO_MERCHANT_ID, caseId, "replacement dispatched"),
    ).toEqual({ ok: true });

    const resolved = await transitionCase(
      db,
      DEMO_MERCHANT_ID,
      caseId,
      "resolved",
      "customer confirmed",
    );
    expect(resolved.ok).toBe(true);

    const workflow = await getCaseWorkflow(db, DEMO_MERCHANT_ID, caseId);
    expect(workflow?.status).toBe("resolved");
    // Reaching a terminal status stops the clock.
    expect(workflow?.resolved_at).not.toBeNull();

    const events = await listCaseEvents(db, DEMO_MERCHANT_ID, caseId);
    expect(events.map((e) => e.kind)).toEqual([
      "routing",
      "status_change",
      "note",
      "status_change",
    ]);
    expect(events[1]).toMatchObject({
      from_status: "open",
      to_status: "in_progress",
    });
    expect(events[2].body).toBe("replacement dispatched");
    expect(events[3].body).toBe("customer confirmed");

    // A resolved case has left the work queue.
    const outstanding = await listQueue(db, DEMO_MERCHANT_ID, filters());
    expect(outstanding.some((r) => r.id === caseId)).toBe(false);
  });

  it("refuses an illegal transition against the case's current status", async () => {
    const done = await completeIntake(
      "905550000608",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );
    const caseId = done.completedCase!.case_id;

    const skipped = await transitionCase(
      db,
      DEMO_MERCHANT_ID,
      caseId,
      "closed",
    );
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) expect(skipped.error).toContain("cannot move");

    // The case is untouched, and no event was written for the refusal.
    const workflow = await getCaseWorkflow(db, DEMO_MERCHANT_ID, caseId);
    expect(workflow?.status).toBe("open");
    const events = await listCaseEvents(db, DEMO_MERCHANT_ID, caseId);
    expect(events.filter((e) => e.kind === "status_change")).toHaveLength(0);
  });

  it("does not act on another merchant's case", async () => {
    const { rows } = await client.query(
      `insert into merchants (name) values ('Other Co.') returning id`,
    );
    const otherMerchantId = (rows[0] as { id: string }).id;
    const done = await completeIntake(
      "905550000609",
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );
    const caseId = done.completedCase!.case_id;

    expect(
      await transitionCase(db, otherMerchantId, caseId, "in_progress"),
    ).toEqual({ ok: false, error: "case not found" });
    expect(
      await addCaseNote(db, otherMerchantId, caseId, "should not land"),
    ).toEqual({ ok: false, error: "case not found" });
    expect(await getCaseWorkflow(db, otherMerchantId, caseId)).toBeNull();
    expect(await listTranscript(db, otherMerchantId, caseId)).toEqual([]);
  });
});

describe("the conversation transcript (SPEC §9)", () => {
  it("records both sides of the intake and attaches it to the case", async () => {
    const phone = "905550000610";
    const done = await completeIntake(
      phone,
      "wrong_damaged_missing",
      "damaged",
      DAMAGE_ANSWERS,
    );

    const transcript = await listTranscript(
      db,
      DEMO_MERCHANT_ID,
      done.completedCase!.case_id,
    );

    // Greeting + 2 taps + 4 answers inbound, each with a reply out.
    expect(transcript.filter((m) => m.direction === "inbound")).toHaveLength(7);
    expect(transcript.filter((m) => m.direction === "outbound")).toHaveLength(
      7,
    );

    // In order, and readable: the customer's words and the options offered.
    expect(transcript[0]).toMatchObject({
      direction: "inbound",
      body: "merhaba",
    });
    expect(transcript[1].body).toContain("Please pick a topic");
    expect(transcript.some((m) => m.body === 'tapped "damaged"')).toBe(true);
    expect(transcript.some((m) => m.body?.includes("media.sim.torn"))).toBe(
      true,
    );
    // Every inbound entry is correlated to its WhatsApp message id.
    expect(
      transcript
        .filter((m) => m.direction === "inbound")
        .every((m) => Boolean(m.wa_message_id)),
    ).toBe(true);
  });

  it("keeps the exchange when a message fails, alongside the generic reply", async () => {
    const phone = "905550000611";
    const failed = await say(phone, "text", "merhaba", "handler_exception");
    expect(failed.error).toContain("processing failed");

    // No case exists yet, so read by conversation to prove nothing was lost
    // (SPEC §13). Exactly two entries: the customer's message — recorded once,
    // however many times the failure path re-records it — and the generic
    // reply, which is the only thing that actually reached them.
    const { rows } = await client.query(
      `select direction, body from conversation_messages
        where merchant_id = $1 and customer_wa_id = $2
        order by created_at, id`,
      [DEMO_MERCHANT_ID, phone],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ direction: "inbound", body: "merhaba" });
    expect((rows[1] as { body: string }).body).toContain(
      "something went wrong",
    );
  });

  it("keeps an abandoned intake's transcript with its case (SPEC §11)", async () => {
    const phone = "905550000612";
    await say(phone, "text", "merhaba");
    await say(phone, "list", "return");
    await say(phone, "list", "doesnt_fit");
    // At least one captured field, or the abandoned session is simply deleted
    // with nothing to file (SPEC §11).
    await say(phone, "text", "#tr-555 555");
    await runSimulatorAction(db, {
      action: "time_travel",
      merchantId: DEMO_MERCHANT_ID,
      phone,
      ageMinutes: 25 * 60,
    });
    const swept = await runSimulatorAction(db, {
      action: "maintenance",
      merchantId: DEMO_MERCHANT_ID,
      phone,
    });
    expect(swept.notice).toContain("abandoned 1");

    const { rows } = await client.query(
      `select id from cases
        where merchant_id = $1 and customer_wa_id = $2 and status = 'abandoned'`,
      [DEMO_MERCHANT_ID, phone],
    );
    const caseId = (rows[0] as { id: string }).id;
    const transcript = await listTranscript(db, DEMO_MERCHANT_ID, caseId);
    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[0].body).toBe("merhaba");
  });
});
