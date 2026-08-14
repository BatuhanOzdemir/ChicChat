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
import { DEMO_MERCHANT_ID, loadMerchantConfig } from "./config";
import { getCaseDetail, listCases } from "./case-queries";
import {
  addCaseNote,
  getCaseWorkflow,
  listCaseEvents,
  listQueue,
  transitionCase,
} from "./console";
import { primaryChannel, resolveMerchantByPhoneNumberId } from "./merchants";
import { loadSessionMeta } from "./sessions";
import { listRules } from "./taxonomy";
import { listTranscript } from "./transcript";
import { forgetFakeConversations } from "./test-isolation";
import { parseCaseFilters, type CaseFilters } from "../lib/cases/filters";
import { runSimulatorAction } from "../server/simulator/service";
import type { SimulatorInputKind } from "../lib/simulator/protocol";

/**
 * Step 6 gate: two merchants with different taxonomies, interleaved
 * conversations from the *same* customer number, and nothing crossing between
 * them.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const SECOND_MERCHANT_ID = "00000000-0000-0000-0000-000000000003";
const SECOND_PHONE_NUMBER_ID = "second-merchant-phone-number-id";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

function filters(overrides: Partial<CaseFilters> = {}): CaseFilters {
  const base = parseCaseFilters({});
  if (!base.ok) throw new Error("default filters must parse");
  return { ...base.value, ...overrides };
}

async function say(
  merchantId: string,
  phone: string,
  kind: SimulatorInputKind,
  value: string,
) {
  return runSimulatorAction(db, {
    action: "message",
    merchantId,
    phone,
    message: { kind, value },
  });
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

describe("merchant resolution by phone_number_id (SPEC §10)", () => {
  it("maps each seeded number to its own merchant", async () => {
    const second = await resolveMerchantByPhoneNumberId(
      db,
      SECOND_PHONE_NUMBER_ID,
    );
    expect(second?.merchantId).toBe(SECOND_MERCHANT_ID);
    expect(second?.merchantName).toBe("Butik Moda");

    // The demo merchant's number comes from the environment when configured, so
    // resolve it the other way round: whatever number it owns must map back.
    const demoChannel = await primaryChannel(db, DEMO_MERCHANT_ID);
    expect(demoChannel).not.toBeNull();
    const demo = await resolveMerchantByPhoneNumberId(
      db,
      demoChannel!.phoneNumberId,
    );
    expect(demo?.merchantId).toBe(DEMO_MERCHANT_ID);
  });

  it("returns null for an unknown number instead of guessing a tenant", async () => {
    expect(
      await resolveMerchantByPhoneNumberId(db, "not-a-configured-number"),
    ).toBeNull();
  });

  it("refuses to let two merchants claim the same number", async () => {
    await expect(
      client.query(
        `insert into whatsapp_channels (merchant_id, phone_number_id)
         values ($1, $2)`,
        [
          SECOND_MERCHANT_ID,
          (await primaryChannel(db, DEMO_MERCHANT_ID))!.phoneNumberId,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe("two merchants, different taxonomies", () => {
  it("offers each merchant's own categories to the same customer", async () => {
    const phone = "905550000701";

    const first = await say(DEMO_MERCHANT_ID, phone, "text", "hello");
    const second = await say(SECOND_MERCHANT_ID, phone, "text", "merhaba");

    const rowIds = (response: typeof first): string[] => {
      const message = response.outbound[0];
      if (!message || message.type !== "interactive") return [];
      return message.interactive.action.sections.flatMap((s) =>
        s.rows.map((r) => r.id),
      );
    };

    expect(rowIds(first)).toContain("return");
    expect(rowIds(first)).not.toContain("iade");
    expect(rowIds(second)).toContain("iade");
    expect(rowIds(second)).not.toContain("return");
  });

  it("keeps interleaved sessions for one phone entirely separate", async () => {
    const phone = "905550000702";

    // Both conversations start, then advance in an interleaved order.
    await say(DEMO_MERCHANT_ID, phone, "text", "hello");
    await say(SECOND_MERCHANT_ID, phone, "text", "merhaba");
    await say(DEMO_MERCHANT_ID, phone, "list", "return");
    await say(SECOND_MERCHANT_ID, phone, "list", "iade");
    await say(DEMO_MERCHANT_ID, phone, "list", "doesnt_fit");
    const secondAsking = await say(SECOND_MERCHANT_ID, phone, "list", "beden");

    const firstSession = await loadSessionMeta(db, DEMO_MERCHANT_ID, phone);
    const secondSession = await loadSessionMeta(db, SECOND_MERCHANT_ID, phone);

    // Each session is on its own merchant's taxonomy, waiting on its own field.
    expect(firstSession?.state.categoryKey).toBe("return");
    expect(firstSession?.state.pendingFieldKey).toBe("order_number");
    expect(secondSession?.state.categoryKey).toBe("iade");
    expect(secondSession?.state.pendingFieldKey).toBe("siparis_no");
    expect(secondAsking.session?.subcategoryKey).toBe("beden");
  });

  it("files each completed case against its own merchant, invisible to the other", async () => {
    const phone = "905550000703";

    // Finish the second merchant's shorter intake.
    await say(SECOND_MERCHANT_ID, phone, "text", "merhaba");
    await say(SECOND_MERCHANT_ID, phone, "list", "kargo");
    await say(SECOND_MERCHANT_ID, phone, "list", "gelmedi");
    const done = await say(SECOND_MERCHANT_ID, phone, "text", "BM12345");
    expect(done.completedCase).not.toBeNull();
    const caseId = done.completedCase!.case_id;

    // Its own routing rules applied — not the other merchant's.
    expect(done.completedCase).toMatchObject({
      category: "kargo",
      queue: "kargo_takip",
      priority: "high",
      status: "escalated",
    });

    // Visible to its owner…
    expect(
      (await listCases(db, SECOND_MERCHANT_ID, filters())).rows.some(
        (r) => r.id === caseId,
      ),
    ).toBe(true);
    expect(await getCaseDetail(db, SECOND_MERCHANT_ID, caseId)).not.toBeNull();

    // …and to nobody else, on every read path the console uses.
    expect(
      (await listCases(db, DEMO_MERCHANT_ID, filters())).rows.some(
        (r) => r.id === caseId,
      ),
    ).toBe(false);
    expect(await getCaseDetail(db, DEMO_MERCHANT_ID, caseId)).toBeNull();
    expect(
      (
        await listQueue(db, DEMO_MERCHANT_ID, {
          queue: null,
          categoryKey: null,
          status: null,
        })
      ).some((r) => r.id === caseId),
    ).toBe(false);
    expect(await getCaseWorkflow(db, DEMO_MERCHANT_ID, caseId)).toBeNull();
    expect(await listCaseEvents(db, DEMO_MERCHANT_ID, caseId)).toEqual([]);
    expect(await listTranscript(db, DEMO_MERCHANT_ID, caseId)).toEqual([]);
  });

  it("shows and searches the order number under the tenant's own field name", async () => {
    const phone = "905550000706";
    await say(SECOND_MERCHANT_ID, phone, "text", "merhaba");
    await say(SECOND_MERCHANT_ID, phone, "list", "kargo");
    await say(SECOND_MERCHANT_ID, phone, "list", "gecikti");
    // Butik Moda calls the field `siparis_no`, not `order_number`.
    const done = await say(SECOND_MERCHANT_ID, phone, "text", " bm-98 765 ");
    const caseId = done.completedCase!.case_id;
    expect(done.completedCase!.fields.siparis_no).toBe("BM98765");

    const listed = await listCases(db, SECOND_MERCHANT_ID, filters());
    const row = listed.rows.find((r) => r.id === caseId);
    expect(row?.order_number).toBe("BM98765");

    const queued = await listQueue(db, SECOND_MERCHANT_ID, {
      queue: null,
      categoryKey: null,
      status: null,
    });
    expect(queued.find((r) => r.id === caseId)?.order_number).toBe("BM98765");

    // …and the messy-input search finds it, as it does for the other tenant.
    const searched = await listCases(
      db,
      SECOND_MERCHANT_ID,
      filters({ orderNumber: "BM98765" }),
    );
    expect(searched.rows.some((r) => r.id === caseId)).toBe(true);
  });

  it("refuses writes from the wrong tenant", async () => {
    const phone = "905550000704";
    await say(SECOND_MERCHANT_ID, phone, "text", "merhaba");
    await say(SECOND_MERCHANT_ID, phone, "list", "kargo");
    await say(SECOND_MERCHANT_ID, phone, "list", "gecikti");
    const done = await say(SECOND_MERCHANT_ID, phone, "text", "BM99999");
    const caseId = done.completedCase!.case_id;

    expect(
      await transitionCase(db, DEMO_MERCHANT_ID, caseId, "in_progress"),
    ).toEqual({ ok: false, error: "case not found" });
    expect(await addCaseNote(db, DEMO_MERCHANT_ID, caseId, "not mine")).toEqual(
      {
        ok: false,
        error: "case not found",
      },
    );

    // The owner can still work it, so the refusal was scoping and not a lock.
    expect(
      (await transitionCase(db, SECOND_MERCHANT_ID, caseId, "in_progress")).ok,
    ).toBe(true);
  });

  it("keeps configuration and routing rules per merchant", async () => {
    const first = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const second = await loadMerchantConfig(db, SECOND_MERCHANT_ID);

    expect(first?.categories.map((c) => c.key)).toContain("return");
    expect(second?.categories.map((c) => c.key)).toEqual(["iade", "kargo"]);
    // Different policy windows, so "within the return window" differs by tenant.
    expect(first?.settings.return_window_days).toBe(30);
    expect(second?.settings.return_window_days).toBe(14);

    const secondRules = await listRules(db, SECOND_MERCHANT_ID);
    expect(secondRules.map((r) => r.target_queue)).toEqual([
      "iade_istisna",
      "iade_kuyrugu",
      "kargo_takip",
    ]);
    expect(
      (await listRules(db, DEMO_MERCHANT_ID)).some(
        (r) => r.target_queue === "iade_kuyrugu",
      ),
    ).toBe(false);
  });

  it("gives each merchant its own idempotency ledger", async () => {
    const phone = "905550000705";
    const messageId = "wamid.shared.across.tenants";

    // Meta message ids are unique per number, but the ledger must be scoped
    // anyway: one tenant's delivery cannot suppress another's message.
    const first = await runSimulatorAction(db, {
      action: "message",
      merchantId: DEMO_MERCHANT_ID,
      phone,
      message: { kind: "text", value: "hello", messageId },
    });
    const second = await runSimulatorAction(db, {
      action: "message",
      merchantId: SECOND_MERCHANT_ID,
      phone,
      message: { kind: "text", value: "merhaba", messageId },
    });

    expect(first.outbound).toHaveLength(1);
    expect(second.outbound).toHaveLength(1);
    expect(second.error).toBeNull();

    // Replaying it for the same tenant *is* skipped.
    const replay = await runSimulatorAction(db, {
      action: "message",
      merchantId: SECOND_MERCHANT_ID,
      phone,
      message: { kind: "text", value: "merhaba", messageId },
    });
    expect(replay.error).toContain("duplicate");
  });
});
