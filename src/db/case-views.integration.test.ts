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
import { forgetFakeConversations } from "./test-isolation";
import {
  caseCounters,
  getCaseDetail,
  listCases,
  listErroredSessions,
} from "./case-queries";
import { parseCaseFilters, type CaseFilters } from "../lib/cases/filters";
import { abandonmentRate } from "../lib/cases/analytics";
import { runSimulatorAction } from "../server/simulator/service";
import type { SimulatorInputKind } from "../lib/simulator/protocol";

/**
 * Step 4 gate (SPEC §8): cases produced in the simulator show up correctly in
 * the list, its filters, the detail view and the counters — and an abandoned
 * case plus an errored session both surface.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

function filters(overrides: Partial<CaseFilters> = {}): CaseFilters {
  const base = parseCaseFilters({});
  if (!base.ok) throw new Error("default filters must parse");
  return { ...base.value, ...overrides };
}

async function sim(
  action: "message" | "maintenance" | "time_travel",
  phone: string,
  extra: Record<string, unknown> = {},
) {
  return runSimulatorAction(db, {
    action,
    merchantId: DEMO_MERCHANT_ID,
    phone,
    ...extra,
  } as Parameters<typeof runSimulatorAction>[1]);
}

async function say(
  phone: string,
  kind: SimulatorInputKind,
  value: string,
  injectError?: "handler_exception",
) {
  return sim("message", phone, {
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

const RETURN_ANSWERS = {
  order_number: { kind: "text" as const, value: "  #tr-100 432 " },
  item_ref: { kind: "text" as const, value: "blue shirt" },
  reason: { kind: "text" as const, value: "does not fit" },
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

describe("cases generated in the simulator appear in the list", () => {
  it("lists a completed case with its order number and category", async () => {
    const phone = "905550000501";
    const done = await completeIntake(
      phone,
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );
    expect(done.completedCase).not.toBeNull();

    const page = await listCases(db, DEMO_MERCHANT_ID, filters());
    const row = page.rows.find((r) => r.id === done.completedCase!.case_id);
    expect(row).toMatchObject({
      status: "open",
      category_key: "return",
      subcategory_key: "doesnt_fit",
      order_number: "TR100432",
      customer_wa_id: phone,
    });
    expect(row!.field_count).toBe(4);
    expect(page.total).toBeGreaterThan(0);
  });

  it("filters by status, category, order number and date", async () => {
    const phone = "905550000502";
    const done = await completeIntake(
      phone,
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );
    const caseId = done.completedCase!.case_id;

    // Order-number search accepts messy input (normalized in the filter).
    const byOrder = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ orderNumber: "TR100432" }),
    );
    expect(byOrder.rows.some((r) => r.id === caseId)).toBe(true);

    const wrongOrder = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ orderNumber: "TR999999" }),
    );
    expect(wrongOrder.rows.some((r) => r.id === caseId)).toBe(false);

    const byCategory = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ categoryKey: "return" }),
    );
    expect(byCategory.rows.some((r) => r.id === caseId)).toBe(true);

    const otherCategory = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ categoryKey: "wismo" }),
    );
    expect(otherCategory.rows.some((r) => r.id === caseId)).toBe(false);

    const abandonedOnly = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ status: "abandoned" }),
    );
    expect(abandonedOnly.rows.some((r) => r.id === caseId)).toBe(false);

    const today = new Date().toISOString().slice(0, 10);
    const inRange = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ from: today, to: today }),
    );
    expect(inRange.rows.some((r) => r.id === caseId)).toBe(true);

    const past = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ from: "2020-01-01", to: "2020-01-02" }),
    );
    expect(past.rows.some((r) => r.id === caseId)).toBe(false);
  });

  it("shows raw and normalized values, and a timeline, in the detail view", async () => {
    const phone = "905550000503";
    const done = await completeIntake(
      phone,
      "wrong_damaged_missing",
      "damaged",
      {
        order_number: { kind: "text", value: "#tr-100 432" },
        item_ref: { kind: "text", value: "red dress" },
        description: { kind: "text", value: "  seam  torn " },
        photo: { kind: "photo", value: "media.sim.torn" },
      },
    );

    const detail = await getCaseDetail(
      db,
      DEMO_MERCHANT_ID,
      done.completedCase!.case_id,
    );
    expect(detail).not.toBeNull();
    expect(detail!.category_key).toBe("wrong_damaged_missing");

    const order = detail!.fields.find((f) => f.field_key === "order_number")!;
    expect(order.raw_value).toBe("#tr-100 432");
    expect(order.normalized_value).toBe("TR100432");

    // The photo is typed as media so the view can list it separately.
    const photo = detail!.fields.find((f) => f.field_key === "photo")!;
    expect(photo.type).toBe("media");

    // Every field carries a capture time, which is what the timeline renders.
    expect(detail!.fields.every((f) => Boolean(f.created_at))).toBe(true);
    // The intake start was recorded, so "how long did it take" is answerable.
    expect(detail!.intake_started_at).not.toBeNull();
  });

  it("does not expose another merchant's case", async () => {
    const { rows } = await client.query(
      `insert into merchants (name) values ('Other Co.') returning id`,
    );
    const otherMerchantId = (rows[0] as { id: string }).id;
    const done = await completeIntake(
      "905550000504",
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );
    expect(
      await getCaseDetail(db, otherMerchantId, done.completedCase!.case_id),
    ).toBeNull();
  });
});

describe("counters (SPEC §8)", () => {
  it("counts by status, category and day, and measures intake duration", async () => {
    await completeIntake(
      "905550000505",
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );

    const counters = await caseCounters(db, DEMO_MERCHANT_ID);
    expect(counters.byStatus.some((s) => s.status === "open")).toBe(true);
    expect(counters.byCategory.some((c) => c.category_key === "return")).toBe(
      true,
    );
    const today = new Date().toISOString().slice(0, 10);
    expect(counters.byDay.some((d) => d.day === today)).toBe(true);
    // Intake durations exist now that intake_started_at is recorded.
    expect(counters.medianIntakeSeconds).not.toBeNull();
    expect(counters.medianIntakeSeconds!).toBeGreaterThanOrEqual(0);
  });

  it("reports an abandonment rate once a session is abandoned", async () => {
    // One completed case…
    await completeIntake(
      "905550000506",
      "return",
      "doesnt_fit",
      RETURN_ANSWERS,
    );

    // …and one that goes quiet with progress, then passes the horizon.
    const quiet = "905550000507";
    await say(quiet, "text", "merhaba");
    await say(quiet, "list", "return");
    await say(quiet, "list", "doesnt_fit");
    await say(quiet, "list", "unworn_tags_on");
    await sim("time_travel", quiet, { ageMinutes: 25 * 60 });
    const swept = await sim("maintenance", quiet);
    expect(swept.notice).toContain("abandoned 1");

    const counters = await caseCounters(db, DEMO_MERCHANT_ID);
    expect(counters.abandoned).toBeGreaterThan(0);
    expect(
      abandonmentRate(counters.completed, counters.abandoned),
    ).toBeGreaterThan(0);

    // The abandoned case is listed, and findable by its status filter.
    const abandoned = await listCases(
      db,
      DEMO_MERCHANT_ID,
      filters({ status: "abandoned" }),
    );
    expect(abandoned.rows.some((r) => r.customer_wa_id === quiet)).toBe(true);
  });
});

describe("errored sessions surface for the console (SPEC §13)", () => {
  it("lists a session that hit an unexpected error", async () => {
    const phone = "905550000508";
    await say(phone, "text", "merhaba", "handler_exception");

    const errored = await listErroredSessions(db, DEMO_MERCHANT_ID);
    const row = errored.find((s) => s.customer_wa_id === phone);
    expect(row).toBeDefined();
    expect(row!.last_error).toContain("injected");
  });
});
