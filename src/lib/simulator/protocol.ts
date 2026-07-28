/**
 * Simulator wire protocol (SPEC §7) — pure types plus boundary parsing.
 *
 * The simulator endpoint is external input like any other, so its body is
 * parsed and validated here (Handbook §5) and the result is a discriminated
 * union rather than a thrown error (Handbook §3).
 */

/** What the tester did in the chat UI. */
export type SimulatorInputKind = "text" | "list" | "photo" | "flow";

export interface SimulatorMessageInput {
  kind: SimulatorInputKind;
  /**
   * text body · tapped list-row id · fake media id · Flow `response_json`.
   */
  value: string;
  /**
   * Reuse a previous id to replay a duplicate delivery (SPEC §11 idempotency).
   * Generated per message when omitted.
   */
  messageId?: string;
}

/**
 * Error injection (SPEC §7). `handler_exception` forces a real exception inside
 * message processing. `integration_down` is accepted and echoed but has nothing
 * to degrade until the first connector exists (Step 9) — see docs/RETROFIT.md.
 */
export type SimulatorErrorInjection = "handler_exception" | "integration_down";

export type SimulatorAction =
  | "message"
  | "reset"
  | "time_travel"
  | "state"
  /** Run the inactivity maintenance job now (nudge / abandon, SPEC §11). */
  | "maintenance";

export interface SimulatorRequest {
  action: SimulatorAction;
  merchantId: string;
  /** Fake customer phone, digits only (E.164 without `+`). */
  phone: string;
  message?: SimulatorMessageInput;
  /** Minutes to age the session by (action `time_travel`). */
  ageMinutes?: number;
  injectError?: SimulatorErrorInjection;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const ACTIONS: readonly SimulatorAction[] = [
  "message",
  "reset",
  "time_travel",
  "state",
  "maintenance",
];
const KINDS: readonly SimulatorInputKind[] = ["text", "list", "photo", "flow"];
const INJECTIONS: readonly SimulatorErrorInjection[] = [
  "handler_exception",
  "integration_down",
];

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function parseMessage(
  raw: unknown,
): ParseResult<SimulatorMessageInput> | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "message must be an object" };
  }
  const m = raw as Record<string, unknown>;
  const kind = str(m.kind);
  if (!kind || !KINDS.includes(kind as SimulatorInputKind)) {
    return {
      ok: false,
      error: `message.kind must be one of ${KINDS.join("|")}`,
    };
  }
  // A photo/flow value may be long, a text value may be any non-empty string.
  const value = typeof m.value === "string" ? m.value : null;
  if (value === null || value === "") {
    return { ok: false, error: "message.value must be a non-empty string" };
  }
  const messageId = str(m.messageId);
  return {
    ok: true,
    value: {
      kind: kind as SimulatorInputKind,
      value,
      ...(messageId ? { messageId } : {}),
    },
  };
}

export function parseSimulatorRequest(
  body: unknown,
): ParseResult<SimulatorRequest> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const action = str(b.action);
  if (!action || !ACTIONS.includes(action as SimulatorAction)) {
    return { ok: false, error: `action must be one of ${ACTIONS.join("|")}` };
  }

  const merchantId = str(b.merchantId);
  if (!merchantId) return { ok: false, error: "merchantId is required" };

  const rawPhone = str(b.phone);
  if (!rawPhone) return { ok: false, error: "phone is required" };
  const phone = rawPhone.replace(/[^\d]/g, "");
  if (phone.length < 6) {
    return { ok: false, error: "phone must contain at least 6 digits" };
  }

  const injectRaw = str(b.injectError);
  if (injectRaw && !INJECTIONS.includes(injectRaw as SimulatorErrorInjection)) {
    return {
      ok: false,
      error: `injectError must be one of ${INJECTIONS.join("|")}`,
    };
  }
  const injectError = injectRaw as SimulatorErrorInjection | null;

  const request: SimulatorRequest = {
    action: action as SimulatorAction,
    merchantId,
    phone,
    ...(injectError ? { injectError } : {}),
  };

  if (request.action === "message") {
    const parsed = parseMessage(b.message);
    if (!parsed.ok) return parsed;
    request.message = parsed.value;
  }

  if (request.action === "time_travel") {
    const minutes = typeof b.ageMinutes === "number" ? b.ageMinutes : NaN;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, error: "ageMinutes must be a positive number" };
    }
    request.ageMinutes = Math.floor(minutes);
  }

  return { ok: true, value: request };
}
