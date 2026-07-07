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
import { buildHandoff, persistCase, type Queryable } from "./cases";
import { simulateIntake } from "../lib/intake";
import { demoIntakeConfig } from "../lib/intake/fixtures";

/**
 * Step 6 gate: a full Tier-0 intake via the simulator is persisted, read back,
 * and the agent-handoff JSON matches. Runs against the live local Supabase DB.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

const client = new Client({ connectionString: DATABASE_URL });
const db = client as unknown as Queryable;

beforeAll(async () => {
  await client.connect();
  // Ensure the demo merchant + taxonomy exist (idempotent).
  execFileSync("node", ["scripts/seed.mjs"], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
}, 60_000);

afterAll(async () => {
  await client.end();
});

// Keep the DB clean: each test's writes happen in a rolled-back transaction.
beforeEach(async () => {
  await client.query("begin");
});
afterEach(async () => {
  await client.query("rollback");
});

describe("Tier-0 intake -> persist -> handoff", () => {
  it("round-trips a wrong/damaged case into a matching handoff package", async () => {
    const { case: intakeCase } = simulateIntake(demoIntakeConfig, {
      category: "wrong_damaged_missing",
      subcategory: "damaged",
      fields: {
        order_number: "#tr-100 432",
        item_ref: "the red summer dress",
        photo: "wamid.HBgMedia123",
        description: "  the seam is torn  ",
      },
    });
    expect(intakeCase).toBeDefined();

    const caseId = await persistCase(db, {
      merchantId: MERCHANT_ID,
      customerWaId: "+905550000001",
      categoryKey: intakeCase!.category,
      subcategoryKey: intakeCase!.subcategory,
      integrationTier: intakeCase!.integration_tier,
      fields: intakeCase!.fields,
    });

    const handoff = await buildHandoff(db, caseId);

    const expectedFields = Object.fromEntries(
      intakeCase!.fields.map((f) => [f.key, f.normalized]),
    );

    expect(handoff).toEqual({
      case_id: caseId,
      category: "wrong_damaged_missing",
      subcategory: "damaged",
      integration_tier: 0,
      status: "open",
      customer_wa_id: "+905550000001",
      fields: expectedFields,
      photos: ["wamid.HBgMedia123"],
      items: [],
    });
    // sanity: normalization actually happened on the way in
    expect(handoff.fields.order_number).toBe("TR100432");
    expect(handoff.fields.description).toBe("the seam is torn");
  });
});

describe("persist with selected line items (Tier 1+ picker)", () => {
  it("stores and returns case_items in the handoff", async () => {
    const caseId = await persistCase(db, {
      merchantId: MERCHANT_ID,
      customerWaId: "+905550000002",
      categoryKey: "return",
      subcategoryKey: "doesnt_fit",
      integrationTier: 1,
      fields: [
        { key: "order_number", raw: "TR100432", normalized: "TR100432" },
        { key: "reason", raw: "doesnt fit", normalized: "doesnt fit" },
      ],
      items: [
        {
          lineItemId: "li_8841",
          title: "Slim Fit Shirt — Blue / M",
          variant: "Blue / M",
          qty: 1,
        },
        {
          lineItemId: "li_8842",
          title: "Chino Trousers — Beige / 32",
          variant: "Beige / 32",
          qty: 2,
        },
      ],
    });

    const handoff = await buildHandoff(db, caseId);
    expect(handoff.integration_tier).toBe(1);
    expect(handoff.items).toEqual([
      {
        line_item_id: "li_8841",
        title: "Slim Fit Shirt — Blue / M",
        variant: "Blue / M",
        qty: 1,
      },
      {
        line_item_id: "li_8842",
        title: "Chino Trousers — Beige / 32",
        variant: "Beige / 32",
        qty: 2,
      },
    ]);
    expect(handoff.photos).toEqual([]);
    expect(handoff.fields).toEqual({
      order_number: "TR100432",
      reason: "doesnt fit",
    });
  });
});

describe("persistCase validation", () => {
  it("rejects an unknown category", async () => {
    await expect(
      persistCase(db, {
        merchantId: MERCHANT_ID,
        customerWaId: "+905550000003",
        categoryKey: "not_a_category",
        fields: [],
      }),
    ).rejects.toThrow(/unknown category/);
  });
});
