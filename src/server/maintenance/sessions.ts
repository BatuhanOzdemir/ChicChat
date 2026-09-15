/**
 * Session inactivity maintenance (SPEC §11).
 *
 * Two behaviours, both merchant-configurable:
 *  - after `nudge_after_minutes` of silence, send exactly ONE gentle resume
 *    prompt and mark the session `nudged`;
 *  - after `abandon_after_hours`, close the session — a session that captured
 *    at least one field becomes an `abandoned` case so the work is not lost,
 *    an empty one is simply deleted.
 *
 * Progress is never discarded early: nothing here touches a session's captured
 * fields, so a customer who replies later resumes exactly where they left off.
 */
import { inactivityAction } from "@/lib/intake";
import type { IntakeState } from "@/lib/intake";
import { nudgeMessage } from "@/lib/whatsapp";
import type { OutboundMessage } from "@/lib/whatsapp";
import { persistCase } from "@/db/cases";
import { clientDatabase, type Database } from "@/db/database";
import { lockConversation } from "@/db/conversation-lock";
import { enqueueReply, type DeliveryChannel } from "@/db/outbox";
import { deliverReplies } from "@/server/whatsapp/outbox";
import { deleteSession, setSessionStatus } from "@/db/sessions";
import { logger as defaultLogger, type Logger } from "@/server/logging/logger";

export interface MaintenanceDeps {
  db: Database;
  /**
   * Sends on behalf of one merchant. The job sweeps every tenant, and a nudge
   * has to go out from that merchant's own number (SPEC §10), so the sender is
   * resolved per merchant rather than fixed for the run.
   */
  send: (merchantId: string, message: OutboundMessage) => Promise<void>;
  logger?: Logger;
}

export interface MaintenanceSummary {
  nudged: number;
  abandoned: number;
  deleted: number;
  /** Sessions this run could not process; each one is logged. */
  failed: number;
}

interface DueRow {
  locale: string;
  id: string;
  nudged_at: string | null;
  delivery_channel: DeliveryChannel;
  merchant_id: string;
  customer_wa_id: string;
  state: IntakeState;
  status: "active" | "nudged" | "errored";
  created_at: string;
  updated_at: string;
  nudge_after_minutes: number | null;
  abandon_after_hours: number | null;
}

/** Sessions with their merchant's thresholds, oldest activity first. */
async function loadCandidates(
  db: Database,
  merchantId?: string,
  channel?: DeliveryChannel,
  sessionId?: string,
  now = new Date(),
  phone?: string,
): Promise<DueRow[]> {
  const { rows } = await db.query(
    `select m.locale, s.id, s.nudged_at, s.delivery_channel, s.merchant_id, s.customer_wa_id, s.state, s.status,
            s.created_at, s.updated_at,
            c.nudge_after_minutes, c.abandon_after_hours
       from intake_sessions s
       join merchants m on m.id=s.merchant_id
       left join merchant_config c on c.merchant_id = s.merchant_id
      where ($1::uuid is null or s.merchant_id = $1)
        and ($2::text is null or s.delivery_channel=$2)
        and ($3::uuid is null or s.id=$3)
        and ($5::text is null or s.customer_wa_id=$5)
        and ($3::uuid is not null
          or s.updated_at <= $4::timestamptz - coalesce(c.abandon_after_hours,24)*interval '1 hour'
          or (s.status='active' and s.nudged_at is null
            and s.updated_at <= $4::timestamptz - coalesce(c.nudge_after_minutes,5)*interval '1 minute'))
      order by s.updated_at asc
      limit 500`,
    [
      merchantId ?? null,
      channel ?? null,
      sessionId ?? null,
      now,
      phone ?? null,
    ],
  );
  return rows as DueRow[];
}

/**
 * Turn an abandoned session into an `abandoned` case when anything was
 * captured. Requires a category — without one there is nothing to file.
 */
async function abandonSession(
  deps: MaintenanceDeps,
  row: DueRow,
  log: Logger,
): Promise<"abandoned" | "deleted"> {
  const state = row.state;
  const fields = Object.entries(state.fields ?? {})
    .filter(([, value]) => value?.valid)
    .map(([key, value]) => ({
      key,
      raw: value.raw,
      normalized: value.normalized,
    }));

  const context = {
    merchantId: row.merchant_id,
    phone: row.customer_wa_id,
    correlationId: `maintenance:${row.id}`,
  };

  if (fields.length > 0 && state.categoryKey) {
    const caseId = await persistCase(deps.db, {
      merchantId: row.merchant_id,
      customerWaId: row.customer_wa_id,
      categoryKey: state.categoryKey,
      subcategoryKey: state.subcategoryKey ?? null,
      integrationTier: 0,
      status: "abandoned",
      intakeStartedAt: row.created_at,
      fields,
    });
    await deleteSession(deps.db, row.merchant_id, row.customer_wa_id);
    log.info("session_abandoned", { ...context, case_id: caseId, kept: true });
    return "abandoned";
  }

  await deleteSession(deps.db, row.merchant_id, row.customer_wa_id);
  log.info("session_abandoned", { ...context, kept: false });
  return "deleted";
}

export async function runSessionMaintenance(
  deps: MaintenanceDeps,
  now: Date = new Date(),
  merchantId?: string,
  channel?: DeliveryChannel,
  phone?: string,
): Promise<MaintenanceSummary> {
  const log = deps.logger ?? defaultLogger;
  const summary: MaintenanceSummary = {
    nudged: 0,
    abandoned: 0,
    deleted: 0,
    failed: 0,
  };

  for (const row of await loadCandidates(
    deps.db,
    merchantId,
    channel,
    undefined,
    now,
    phone,
  )) {
    // One conversation must not take the sweep down with it. This job runs
    // unattended across every tenant, so a single expired WhatsApp token or
    // unreachable merchant would otherwise stop everyone else's nudges.
    try {
      const delta = { nudged: 0, abandoned: 0, deleted: 0, failed: 0 };
      const events: (() => void)[] = [];
      const buffered: Logger = {
        info: (...args) => {
          events.push(() => log.info(...args));
        },
        warn: (...args) => {
          events.push(() => log.warn(...args));
        },
        error: (...args) => {
          events.push(() => log.error(...args));
        },
      };
      await deps.db.transaction(async (tx) => {
        await lockConversation(tx, row.merchant_id, row.customer_wa_id);
        const db = clientDatabase(tx);
        const [fresh] = await loadCandidates(db, merchantId, channel, row.id);
        if (fresh)
          await maintainSession({ ...deps, db }, fresh, now, delta, buffered);
      });
      summary.nudged += delta.nudged;
      summary.abandoned += delta.abandoned;
      summary.deleted += delta.deleted;
      events.forEach((emit) => emit());
      const delivery = await deliverReplies(
        deps.db,
        row.merchant_id,
        row.customer_wa_id,
        (message) => deps.send(row.merchant_id, message),
        row.delivery_channel,
      );
      if (delivery.failed) throw new Error("nudge delivery pending retry");
    } catch (err) {
      summary.failed += 1;
      log.error("unexpected_exception", err, {
        merchantId: row.merchant_id,
        phone: row.customer_wa_id,
        correlationId: `maintenance:${row.id}`,
        during: "session_maintenance",
      });
    }
  }

  return summary;
}

/** Nudge, abandon or leave alone — one session. Throws on failure. */
async function maintainSession(
  deps: MaintenanceDeps,
  row: DueRow,
  now: Date,
  summary: MaintenanceSummary,
  log: Logger,
): Promise<void> {
  const action = inactivityAction(
    {
      status: row.status,
      updatedAt: new Date(row.updated_at),
      nudgedAt: row.nudged_at ? new Date(row.nudged_at) : null,
    },
    {
      nudgeAfterMinutes: row.nudge_after_minutes ?? 5,
      abandonAfterHours: row.abandon_after_hours ?? 24,
    },
    now,
  );

  if (action === "none") return;

  if (action === "nudge") {
    // State and durable reply commit together; transport retries cannot lose a nudge.
    await setSessionStatus(
      deps.db,
      row.merchant_id,
      row.customer_wa_id,
      "nudged",
    );
    await enqueueReply(deps.db, {
      merchantId: row.merchant_id,
      phone: row.customer_wa_id,
      key: "nudge:" + row.id,
      channel: row.delivery_channel,
      message: nudgeMessage(row.customer_wa_id, row.locale),
    });
    log.info("session_nudged", {
      merchantId: row.merchant_id,
      phone: row.customer_wa_id,
      correlationId: `maintenance:${row.id}`,
    });
    summary.nudged += 1;
    return;
  }

  const outcome = await abandonSession(deps, row, log);
  if (outcome === "abandoned") summary.abandoned += 1;
  else summary.deleted += 1;
}
