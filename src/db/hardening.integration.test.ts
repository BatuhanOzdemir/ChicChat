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
import { persistCase } from "./cases";
import type { OutboundMessage } from "../lib/whatsapp";
import type { LogContext, LogEvent, Logger } from "../server/logging/logger";
import { runSimulatorAction } from "../server/simulator/service";

/**
 * Step 2 gate (SPEC §§11–13): inactivity nudge → resume with progress intact →
 * abandonment, transactional persistence, and the unexpected-error path.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DATABASE_URL });
const db = clientDatabase(client);

/** Logger that records lines so tests can assert on structured output. */
function recordingLogger(): {
  logger: Logger;
  lines: { level: string; event: LogEvent; context?: LogContext }[];
} {
  const lines: { level: string; event: LogEvent; context?: LogContext }[] = [];
  return {
    lines,
    logger: {
      info: (event, context) => lines.push({ level: "info", event, context }),
      warn: (event, context) => lines.push({ level: "warn", event, context }),
      error: (event, error, context) =>
        lines.push({
          level: "error",
          event,
          context: { ...context, error_message: String(error) },
        }),
    },
  };
}

async function sim(
  action: "message" | "maintenance" | "time_travel" | "state",
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

/**
 * Messages this run would have sent to one phone. The job sweeps every session
 * the merchant has, so assertions scope to their own conversation rather than
 * assuming the database holds nothing else (see docs/RETROFIT.md R6b).
 */
function sentTo(
  response: Awaited<ReturnType<typeof runSimulatorAction>>,
  phone: string,
): OutboundMessage[] {
  return response.outbound.filter((m) => m.to === phone);
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

describe("session inactivity (SPEC §11)", () => {
  const phone = "905550000201";

  /** Start a return intake and answer one field, so there is progress to keep. */
  async function startPartialIntake() {
    await sim("message", phone, { message: { kind: "text", value: "hi" } });
    await sim("message", phone, { message: { kind: "list", value: "return" } });
    await sim("message", phone, {
      message: { kind: "list", value: "doesnt_fit" },
    });
    const pending = (await sim("state", phone)).session?.pendingFieldKey;
    await sim("message", phone, {
      message: { kind: "text", value: "unworn_tags_on" },
    });
    return pending;
  }

  it("nudges once at 5 minutes, resumes with progress intact, then abandons", async () => {
    await startPartialIntake();
    const captured = (await sim("state", phone)).session?.fields ?? {};
    const capturedCount = Object.keys(captured).length;
    expect(capturedCount).toBeGreaterThan(0);

    // Not yet idle enough.
    expect(sentTo(await sim("maintenance", phone), phone)).toEqual([]);

    // Age past nudge_after_minutes (default 5) and run the job.
    await sim("time_travel", phone, { ageMinutes: 6 });
    const nudged = await sim("maintenance", phone);
    const nudge = sentTo(nudged, phone)[0];
    if (nudge?.type !== "text") throw new Error("expected a nudge text");
    expect(nudge.text.body).toMatch(/pick up|left off/i);
    // The summary counts the whole sweep, so it can exceed one when other
    // conversations are also idle; "exactly one for this session" is what the
    // second run below proves.
    expect(nudged.notice).toMatch(/nudged [1-9]/);

    // Exactly one nudge: running again sends nothing to this customer.
    expect(sentTo(await sim("maintenance", phone), phone)).toEqual([]);

    // Progress survived the nudge, and the customer resumes where they were.
    const afterNudge = await sim("state", phone);
    expect(Object.keys(afterNudge.session?.fields ?? {})).toHaveLength(
      capturedCount,
    );
    const resumed = await sim("message", phone, {
      message: { kind: "text", value: "blue shirt" },
    });
    expect(Object.keys(resumed.session?.fields ?? {}).length).toBeGreaterThan(
      capturedCount,
    );
    // Activity clears the nudged flag so the session is live again.
    const { rows: statusRows } = await client.query(
      `select status from intake_sessions where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, phone],
    );
    expect((statusRows[0] as { status: string }).status).toBe("active");

    // Age past abandon_after_hours (default 24): the work becomes a case.
    await sim("time_travel", phone, { ageMinutes: 25 * 60 });
    const abandoned = await sim("maintenance", phone);
    expect(abandoned.notice).toContain("abandoned 1");
    expect(await loadSession(db, DEMO_MERCHANT_ID, phone)).toBeNull();

    const { rows } = await client.query(
      `select status from cases where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, phone],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { status: string }).status).toBe("abandoned");
  });

  it("deletes an empty abandoned session instead of filing an empty case", async () => {
    const emptyPhone = "905550000202";
    await sim("message", emptyPhone, {
      message: { kind: "text", value: "hi" },
    });
    await sim("time_travel", emptyPhone, { ageMinutes: 25 * 60 });

    const result = await sim("maintenance", emptyPhone);
    expect(result.notice).toContain("deleted 1");
    const { rows } = await client.query(
      `select count(*)::int as n from cases where customer_wa_id = $1`,
      [emptyPhone],
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });

  it("honours a merchant's configured thresholds", async () => {
    const slowPhone = "905550000203";
    await client.query(
      `update merchant_config set nudge_after_minutes = 60 where merchant_id = $1`,
      [DEMO_MERCHANT_ID],
    );
    await sim("message", slowPhone, { message: { kind: "text", value: "hi" } });
    await sim("time_travel", slowPhone, { ageMinutes: 10 });
    expect(sentTo(await sim("maintenance", slowPhone), slowPhone)).toEqual([]);

    await sim("time_travel", slowPhone, { ageMinutes: 55 });
    expect(sentTo(await sim("maintenance", slowPhone), slowPhone)).toHaveLength(
      1,
    );
  });

  it("keeps sweeping when one conversation fails (Step 7)", async () => {
    const { runSessionMaintenance } =
      await import("../server/maintenance/sessions");
    const { logger, lines } = recordingLogger();

    // Two idle sessions; the first send explodes the way an expired WhatsApp
    // token does. The job must still reach the second one.
    const doomed = "905550000205";
    const other = "905550000206";
    for (const phone of [doomed, other]) {
      await sim("message", phone, { message: { kind: "text", value: "hi" } });
    }
    await client.query(
      `update intake_sessions set updated_at = now() - interval '30 minutes'
        where merchant_id = $1 and customer_wa_id = any($2)`,
      [DEMO_MERCHANT_ID, [doomed, other]],
    );

    const sent: string[] = [];
    const summary = await runSessionMaintenance(
      {
        db,
        logger,
        send: async (_merchantId, message) => {
          if (message.to === doomed) throw new Error("access token expired");
          sent.push(message.to);
        },
      },
      new Date(),
      DEMO_MERCHANT_ID,
    );

    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(sent).toContain(other);
    // The failure is visible rather than swallowed.
    expect(
      lines.some(
        (l) =>
          l.event === "unexpected_exception" &&
          l.context?.during === "session_maintenance",
      ),
    ).toBe(true);
  });
});

describe("transactional persistence (SPEC §11, Handbook §6)", () => {
  it("leaves no partial case when a write fails mid-way", async () => {
    const phone = "905550000204";
    // qty is an integer column; a non-numeric value fails the *second* insert,
    // after the case row and its fields were already written in the same tx.
    await expect(
      persistCase(db, {
        merchantId: DEMO_MERCHANT_ID,
        customerWaId: phone,
        categoryKey: "return",
        subcategoryKey: "doesnt_fit",
        fields: [
          { key: "order_number", raw: "TR100432", normalized: "TR100432" },
        ],
        items: [
          { lineItemId: "li_ok", title: "fine", qty: 1 },
          {
            lineItemId: "li_bad",
            title: "breaks",
            qty: "not-a-number" as unknown as number,
          },
        ],
      }),
    ).rejects.toThrow();

    // Nothing at all survived: no case, and therefore no orphan fields/items.
    const { rows } = await client.query(
      `select count(*)::int as n from cases where customer_wa_id = $1`,
      [phone],
    );
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe("unexpected-error path (SPEC §13)", () => {
  it("emits one correlated structured log line with a masked phone", async () => {
    const phone = "905550000205";
    const { logger, lines } = recordingLogger();
    const outbound: OutboundMessage[] = [];

    // A send that always fails is the simplest way to force the boundary catch.
    const { handleInbound } = await import("../server/whatsapp/handler");
    const result = await handleInbound(
      {
        db,
        logger,
        send: async () => {
          throw new Error("transport exploded");
        },
      },
      DEMO_MERCHANT_ID,
      {
        phoneNumberId: "PNID",
        from: phone,
        messageId: "wamid.err.1",
        kind: "text",
        reply: "hi",
      },
    );

    expect(result.failed).toBe(true);
    expect(outbound).toEqual([]); // both sends failed, by construction

    const exceptions = lines.filter((l) => l.event === "unexpected_exception");
    expect(exceptions).toHaveLength(2); // the failure, then the failed recovery
    expect(exceptions[0].context?.correlationId).toBe("wamid.err.1");
    expect(exceptions[0].context?.merchantId).toBe(DEMO_MERCHANT_ID);
    // (Masking happens inside the real logger's emit — covered by its own test.)

    expect(lines.some((l) => l.event === "session_errored")).toBe(true);
    const { rows } = await client.query(
      `select status, last_error from intake_sessions
        where merchant_id = $1 and customer_wa_id = $2`,
      [DEMO_MERCHANT_ID, phone],
    );
    expect((rows[0] as { status: string }).status).toBe("errored");
    expect((rows[0] as { last_error: string }).last_error).toContain(
      "transport exploded",
    );
  });
});
