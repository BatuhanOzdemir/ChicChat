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
import {
  DEMO_MERCHANT_ID,
  buildIntakeConfig,
  loadMerchantConfig,
} from "./config";
import {
  createCategory,
  createField,
  createRule,
  createSubcategory,
  deleteCategory,
  deleteField,
  updateCategory,
  updateField,
  updatePolicy,
} from "./taxonomy";
import { parseField, parseNamed, parsePolicy } from "../lib/config/forms";
import { runSimulatorAction } from "../server/simulator/service";

/**
 * Step 3 gate (SPEC §8): a merchant-created category with a custom enum field
 * is usable end-to-end, and disabling a default category removes it from the
 * customer's menu.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

async function send(
  phone: string,
  message: { kind: "text" | "list"; value: string },
) {
  return runSimulatorAction(db, {
    action: "message",
    merchantId: DEMO_MERCHANT_ID,
    phone,
    message,
  });
}

function ok<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  if (!result.ok) throw new Error(`parse failed: ${result.error}`);
  return result.value;
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
});
afterEach(async () => {
  await client.query("rollback");
});

describe("merchant-created category with a custom enum field", () => {
  it("is offered, tappable, and completes an intake", async () => {
    // 1. Create the category the way the UI does: label in, key derived.
    const created = await createCategory(
      db,
      DEMO_MERCHANT_ID,
      ok(parseNamed({ label: "Kargo Şikâyeti", sort_order: "5" }, "category")),
    );
    if (!created.ok) throw new Error(created.error);

    await createSubcategory(
      db,
      DEMO_MERCHANT_ID,
      created.id,
      ok(parseNamed({ label: "Geç teslim" }, "subcategory")),
    );

    // 2. A custom enum field — the thing that used to be unanswerable.
    await createField(
      db,
      DEMO_MERCHANT_ID,
      created.id,
      ok(
        parseField({
          label: "Damage type",
          type: "enum",
          required: "on",
          enum_values: "Torn seam\nStain\nBroken zip",
          sort_order: "10",
        }),
      ),
    );
    await createField(
      db,
      DEMO_MERCHANT_ID,
      created.id,
      ok(
        parseField({
          label: "Order number",
          key: "order_number",
          type: "string",
          required: "on",
          normalize_rule: "order_number",
          sort_order: "20",
        }),
      ),
    );

    // 3. The intake config now includes it, with the derived key.
    const intake = await buildIntakeConfig(db, DEMO_MERCHANT_ID);
    const custom = intake.categories.find((c) => c.key === "kargo_sikayeti");
    expect(custom?.label).toBe("Kargo Şikâyeti");

    // 4. Drive it in the simulator.
    const phone = "905550000301";
    const first = await send(phone, { kind: "text", value: "merhaba" });
    const menu = first.outbound[0];
    if (menu.type !== "interactive") throw new Error("expected a list");
    expect(menu.interactive.action.sections[0].rows.map((r) => r.id)).toContain(
      "kargo_sikayeti",
    );

    await send(phone, { kind: "list", value: "kargo_sikayeti" });
    const afterSub = await send(phone, { kind: "list", value: "gec_teslim" });

    // The enum field is asked as a tappable list, not a free-text question.
    const enumPrompt = afterSub.outbound[0];
    if (enumPrompt.type !== "interactive") {
      throw new Error("expected the enum field to be a List Message");
    }
    expect(
      enumPrompt.interactive.action.sections[0].rows.map((r) => r.id),
    ).toEqual(["torn_seam", "stain", "broken_zip"]);

    // 5. Tap an option, answer the order number, and the case completes.
    await send(phone, { kind: "list", value: "stain" });
    const done = await send(phone, { kind: "text", value: "  #tr-100 432 " });

    expect(done.completedCase).toMatchObject({
      category: "kargo_sikayeti",
      subcategory: "gec_teslim",
    });
    expect(done.completedCase?.fields.damage_type).toBe("stain");
    expect(done.completedCase?.fields.order_number).toBe("TR100432");
  });

  it("rejects a duplicate category key with a readable message", async () => {
    const input = ok(parseNamed({ label: "Kargo Şikâyeti" }, "category"));
    expect((await createCategory(db, DEMO_MERCHANT_ID, input)).ok).toBe(true);

    // Same label a second time derives the same key.
    expect(await createCategory(db, DEMO_MERCHANT_ID, input)).toEqual({
      ok: false,
      error: 'a category with key "kargo_sikayeti" already exists',
    });
  });
});

describe("disabling and editing default categories", () => {
  it("removes a disabled category from the customer's menu", async () => {
    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const exchange = config!.categories.find((c) => c.key === "exchange")!;

    expect(
      (await buildIntakeConfig(db, DEMO_MERCHANT_ID)).categories.map(
        (c) => c.key,
      ),
    ).toContain("exchange");

    await updateCategory(db, DEMO_MERCHANT_ID, exchange.id, {
      label: exchange.label,
      sortOrder: exchange.sortOrder,
      enabled: false,
    });

    const after = await buildIntakeConfig(db, DEMO_MERCHANT_ID);
    expect(after.categories.map((c) => c.key)).not.toContain("exchange");

    // …and it is gone from the menu the customer actually sees.
    const first = await send("905550000302", { kind: "text", value: "hi" });
    const menu = first.outbound[0];
    if (menu.type !== "interactive") throw new Error("expected a list");
    expect(
      menu.interactive.action.sections[0].rows.map((r) => r.id),
    ).not.toContain("exchange");
  });

  it("asks fields in the merchant's configured order", async () => {
    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const other = config!.categories.find((c) => c.key === "other")!;
    const description = other.fields.find((f) => f.key === "description")!;
    const orderNumber = other.fields.find((f) => f.key === "order_number")!;

    // Make order_number required and put it first.
    await updateField(db, DEMO_MERCHANT_ID, orderNumber.id, {
      key: orderNumber.key,
      label: orderNumber.label,
      type: "string",
      required: true,
      enumValues: null,
      normalizeRule: "order_number",
      sortOrder: 1,
    });
    await updateField(db, DEMO_MERCHANT_ID, description.id, {
      key: description.key,
      label: description.label,
      type: "string",
      required: true,
      enumValues: null,
      normalizeRule: null,
      sortOrder: 2,
    });

    const phone = "905550000303";
    await send(phone, { kind: "text", value: "hi" });
    const picked = await send(phone, { kind: "list", value: "other" });
    expect(picked.session?.pendingFieldKey).toBe("order_number");
  });

  it("deletes a category and a field", async () => {
    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const sizing = config!.categories.find((c) => c.key === "sizing_fit")!;
    const question = sizing.fields.find((f) => f.key === "question")!;

    await deleteField(db, DEMO_MERCHANT_ID, question.id);
    await deleteCategory(db, DEMO_MERCHANT_ID, sizing.id);

    const after = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    expect(after!.categories.map((c) => c.key)).not.toContain("sizing_fit");
  });
});

describe("policy settings", () => {
  it("persists inactivity, KVKK and retention values", async () => {
    await updatePolicy(
      db,
      DEMO_MERCHANT_ID,
      ok(
        parsePolicy({
          return_window_days: "45",
          refund_sla_days: "21",
          nudge_after_minutes: "15",
          abandon_after_hours: "48",
          retention_months: "6",
          kvkk_url: "https://demo.example/kvkk",
          order_id_regex: "^[A-Z0-9]{4,}$",
        }),
      ),
    );

    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    expect(config!.settings).toMatchObject({
      return_window_days: 45,
      nudge_after_minutes: 15,
      abandon_after_hours: 48,
      retention_months: 6,
      kvkk_url: "https://demo.example/kvkk",
    });
  });
});

describe("tenant scoping", () => {
  it("will not write a child row into another merchant's category", async () => {
    const { rows } = await client.query(
      `insert into merchants (name) values ('Other Co.') returning id`,
    );
    const otherMerchantId = (rows[0] as { id: string }).id;
    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const victim = config!.categories[0];

    const result = await createField(
      db,
      otherMerchantId,
      victim.id,
      ok(parseField({ label: "sneaky", type: "string" })),
    );
    expect(result).toEqual({ ok: false, error: "unknown category" });

    const rule = await createRule(db, otherMerchantId, victim.id, {
      label: null,
      condition: { all: [] },
      actionType: "route",
      targetQueue: "q",
      priority: null,
    });
    expect(rule.ok).toBe(false);
  });
});
