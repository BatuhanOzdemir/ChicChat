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
import { buildHandoff, type HandoffPackage, type Queryable } from "@/db/cases";
import {
  ageSession,
  deleteSession,
  loadSessionMeta,
  type SessionMeta,
} from "@/db/sessions";
import { handleInbound } from "@/server/whatsapp/handler";

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
  db: Queryable,
  request: SimulatorRequest,
): Promise<SimulatorResponse> {
  const { merchantId, phone } = request;

  if (request.action === "reset") {
    await deleteSession(db, merchantId, phone);
    return emptyResponse();
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
  const recordingSend = async (msg: OutboundMessage): Promise<void> => {
    if (request.injectError === "handler_exception") {
      throw new Error("injected simulator failure (handler_exception)");
    }
    outbound.push(msg);
  };

  let error: string | null = null;
  let completedCase: HandoffPackage | null = null;

  for (const inbound of parseInbound(envelope)) {
    try {
      const { persistedCaseId } = await handleInbound(
        { db, send: recordingSend },
        merchantId,
        inbound,
      );
      if (persistedCaseId) {
        completedCase = await buildHandoff(db, persistedCaseId);
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
