/**
 * Simulator orchestration (SPEC §7) — the permanent test bench.
 *
 * A simulator message is turned into a real Meta webhook envelope, read by the
 * production `parseInbound`, and handed to the production `handleInbound`. Only
 * the signature check is bypassed and the outbound transport is swapped for an
 * in-memory recorder, so no Meta credentials are involved anywhere.
 */
import { parseInbound } from "@/lib/whatsapp";
import type { OutboundMessage } from "@/lib/whatsapp";
import type { IntakeState } from "@/lib/intake";
import { buildInboundEnvelope } from "@/lib/simulator/envelope";
import type { SimulatorRequest } from "@/lib/simulator/protocol";
import { buildHandoff, type HandoffPackage } from "@/db/cases";
import { clientDatabase, type Database, type Queryable } from "@/db/database";
import { lockConversation } from "@/db/conversation-lock";
import {
  ageSession,
  deleteSession,
  loadSessionMeta,
  type SessionMeta,
} from "@/db/sessions";
import { handleInbound } from "@/server/whatsapp/handler";
import { runSessionMaintenance } from "@/server/maintenance/sessions";
import { deliverReplies } from "@/server/whatsapp/outbox";

/** The simulator's own phone_number_id — never a real Meta one. */
export const SIMULATOR_PHONE_NUMBER_ID = "SIMULATOR";

export interface SimulatorResponse {
  /** Messages the bot would have sent, in order. */
  outbound: OutboundMessage[];
  /** Session state after processing (null when completed or reset). */
  session: IntakeState | null;
  sessionMeta: { created_at: string; updated_at: string } | null;
  /** The handoff package, when this message completed an intake. */
  completedCase: HandoffPackage | null;
  /** Set when processing failed (including injected failures). */
  error: string | null;
  /** Echo of an injection that is accepted but not yet actionable. */
  notice: string | null;
}

function newMessageId(): string {
  return `wamid.sim.${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

async function readSession(
  db: Queryable,
  merchantId: string,
  phone: string,
): Promise<{ state: IntakeState | null; meta: SessionMeta | null }> {
  const meta = await loadSessionMeta(db, merchantId, phone);
  return { state: meta?.state ?? null, meta };
}

function emptyResponse(): SimulatorResponse {
  return {
    outbound: [],
    session: null,
    sessionMeta: null,
    completedCase: null,
    error: null,
    notice: null,
  };
}

export async function runSimulatorAction(
  db: Database,
  request: SimulatorRequest,
): Promise<SimulatorResponse> {
  return db.transaction(async (tx) => {
    await lockConversation(tx, request.merchantId, request.phone);
    const { rows } = await tx.query(
      `select 1 from intake_sessions where merchant_id=$1 and customer_wa_id=$2 and delivery_channel='whatsapp'
      union all select 1 from message_inbox where merchant_id=$1 and customer_wa_id=$2 limit 1`,
      [request.merchantId, request.phone],
    );
    if (rows.length)
      return {
        ...emptyResponse(),
        error:
          "This number has real WhatsApp activity. Choose a different fake phone.",
      };
    return runAction(clientDatabase(tx), request);
  });
}

async function runAction(
  db: Database,
  request: SimulatorRequest,
): Promise<SimulatorResponse> {
  const { merchantId, phone } = request;

  if (request.action === "retry_delivery") {
    const outbound: OutboundMessage[] = [];
    const result = await deliverReplies(
      db,
      merchantId,
      phone,
      async (m) => {
        outbound.push(m);
      },
      "simulator",
      true,
    );
    const { state, meta } = await readSession(db, merchantId, phone);
    return {
      ...emptyResponse(),
      outbound,
      session: state,
      sessionMeta: meta,
      notice: `Retried delivery: ${result.sent} sent`,
    };
  }

  if (request.action === "reset") {
    await deleteSession(db, merchantId, phone);
    for (const table of [
      "conversation_messages",
      "conversation_media",
      "message_outbox",
    ]) {
      await db.query(
        `delete from ${table} where merchant_id=$1 and customer_wa_id=$2 and case_id is null`,
        [merchantId, phone],
      );
    }
    return emptyResponse();
  }

  if (request.action === "maintenance") {
    const outbound: OutboundMessage[] = [];
    const summary = await runSessionMaintenance(
      {
        db,
        // Scoped to one merchant below, so the sender ignores the tenant it is
        // handed and simply records what would have gone out.
        send: async (_merchantId, msg) => {
          outbound.push(msg);
        },
      },
      new Date(),
      merchantId,
      "simulator",
      phone,
    );
    const { state, meta } = await readSession(db, merchantId, phone);
    return {
      ...emptyResponse(),
      outbound,
      session: state,
      sessionMeta: meta,
      notice:
        `maintenance: nudged ${summary.nudged}, abandoned ${summary.abandoned}, ` +
        `deleted ${summary.deleted}` +
        // Only mentioned when it happened, so a clean run stays quiet.
        (summary.failed > 0 ? `, failed ${summary.failed}` : ""),
    };
  }

  if (request.action === "time_travel") {
    const aged = await ageSession(
      db,
      merchantId,
      phone,
      request.ageMinutes ?? 0,
    );
    const { state, meta } = await readSession(db, merchantId, phone);
    return {
      ...emptyResponse(),
      session: state,
      sessionMeta: meta,
      notice: aged
        ? `Session aged by ${request.ageMinutes} minute(s).`
        : "No active session to age.",
    };
  }

  if (request.action === "state") {
    const { state, meta } = await readSession(db, merchantId, phone);
    return { ...emptyResponse(), session: state, sessionMeta: meta };
  }

  // action === "message"
  const message = request.message;
  if (!message) {
    return { ...emptyResponse(), error: "message is required" };
  }

  const envelope = buildInboundEnvelope(message, {
    phoneNumberId: SIMULATOR_PHONE_NUMBER_ID,
    from: phone,
    messageId: message.messageId ?? newMessageId(),
  });

  const outbound: OutboundMessage[] = [];
  // `handler_exception` fails only the first send, so the handler's recovery
  // path (generic customer message, SPEC §13) is still observable here.
  let sendsAttempted = 0;
  const recordingSend = async (msg: OutboundMessage): Promise<void> => {
    sendsAttempted += 1;
    if (request.injectError === "delivery_failure" && sendsAttempted === 1) {
      throw new Error("injected delivery failure");
    }
    outbound.push(msg);
  };

  let error: string | null = null;
  let completedCase: HandoffPackage | null = null;

  for (const inbound of parseInbound(envelope)) {
    try {
      const result = await handleInbound(
        {
          db,
          send: recordingSend,
          channel: "simulator",
          loadPhoto: async () => ({
            mimeType: "image/png",
            content: Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l+0AAAAASUVORK5CYII=",
              "base64",
            ),
          }),
          beforeAdvance: () => {
            if (request.injectError === "handler_exception")
              throw new Error("injected handler exception");
          },
        },
        merchantId,
        inbound,
      );
      if (result.persistedCaseId) {
        completedCase = await buildHandoff(db, result.persistedCaseId);
      }
      if (result.duplicate) {
        error = "duplicate delivery skipped (idempotency)";
      } else if (result.failed) {
        error =
          "processing failed or delivery is pending; inspect the session and retry pending delivery.";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const { state, meta } = await readSession(db, merchantId, phone);
  return {
    outbound,
    session: state,
    sessionMeta: meta,
    completedCase,
    error,
    notice:
      request.injectError === "integration_down"
        ? "integration_down accepted, but there is no connector to degrade yet (Step 9)."
        : null,
  };
}
