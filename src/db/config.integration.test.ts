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
import type { Queryable } from "./cases";
import {
  DEMO_MERCHANT_ID,
  buildIntakeConfig,
  loadMerchantConfig,
  setCategoryEnabled,
  setFieldRequired,
  updateMerchantSettings,
} from "./config";
import { simulateIntake } from "../lib/intake";

/**
 * Step 7 gate: merchant-config edits persist AND visibly change what the intake
 * machine asks for. Runs against the live local Supabase DB.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = client as unknown as Queryable;

/** Which fields the intake asks for a given category, given the current config. */
async function askedFieldsFor(category: string): Promise<string[]> {
  const config = await buildIntakeConfig(db, DEMO_MERCHANT_ID);
  const cat = config.categories.find((c) => c.key === category);
  if (!cat) return [];
  const answers = Object.fromEntries(
    cat.fields.map((f) => [f.key, f.type === "media" ? "wamid.x" : "value"]),
  );
  const result = simulateIntake(config, {
    category,
    subcategory: cat.subcategories[0]?.key,
    fields: answers,
  });
  return result.asked;
}

async function categoryKeys(): Promise<string[]> {
  const config = await buildIntakeConfig(db, DEMO_MERCHANT_ID);
  return config.categories.map((c) => c.key);
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

// Each test edits config inside a rolled-back transaction.
beforeEach(async () => {
  await client.query("begin");
});
afterEach(async () => {
  await client.query("rollback");
});

describe("clearing a field's required flag stops the intake asking for it", () => {
  it("drops 'photo' from what wrong/damaged intake asks", async () => {
    const before = await askedFieldsFor("wrong_damaged_missing");
    expect(before).toContain("photo");

    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const cat = config!.categories.find(
      (c) => c.key === "wrong_damaged_missing",
    )!;
    const photo = cat.fields.find((f) => f.key === "photo")!;
    await setFieldRequired(db, photo.id, false);

    const after = await askedFieldsFor("wrong_damaged_missing");
    expect(after).not.toContain("photo");
  });
});

describe("disabling a category removes it from intake", () => {
  it("hides 'return' once disabled", async () => {
    expect(await categoryKeys()).toContain("return");

    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    const ret = config!.categories.find((c) => c.key === "return")!;
    await setCategoryEnabled(db, ret.id, false);

    expect(await categoryKeys()).not.toContain("return");
  });
});

describe("policy settings persist", () => {
  it("updates return window and refund SLA", async () => {
    await updateMerchantSettings(db, DEMO_MERCHANT_ID, {
      return_window_days: 45,
      refund_sla_days: 21,
    });
    const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);
    expect(config!.settings.return_window_days).toBe(45);
    expect(config!.settings.refund_sla_days).toBe(21);
  });
});
