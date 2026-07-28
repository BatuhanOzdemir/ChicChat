/**
 * Structured logging (Handbook §8, SPEC §16): one JSON line per event, always
 * carrying `merchant_id` and a correlation id (the WhatsApp message id), and
 * never carrying PII beyond a masked phone.
 */
import { maskPhone } from "@/lib/logging/mask";

/** The events the system is required to log. */
export type LogEvent =
  | "webhook_received"
  | "webhook_rejected"
  | "validation_failed"
  | "message_skipped_duplicate"
  | "routing_decision"
  | "integration_call"
  | "integration_failure"
  | "case_persisted"
  | "session_nudged"
  | "session_abandoned"
  | "session_errored"
  | "unexpected_exception";

export interface LogContext {
  merchantId?: string;
  /** Correlation id — the inbound WhatsApp message id. */
  correlationId?: string;
  /** Raw phone; it is masked before it reaches the output. */
  phone?: string;
  [key: string]: unknown;
}

export interface Logger {
  info(event: LogEvent, context?: LogContext): void;
  warn(event: LogEvent, context?: LogContext): void;
  error(event: LogEvent, error: unknown, context?: LogContext): void;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, event: LogEvent, context: LogContext = {}): void {
  const { merchantId, correlationId, phone, ...rest } = context;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    merchant_id: merchantId ?? null,
    correlation_id: correlationId ?? null,
    ...(phone !== undefined ? { phone: maskPhone(phone) } : {}),
    ...rest,
  };
  // One line per event; stderr for error level so hosting platforms split them.
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else console.log(serialized);
}

export const logger: Logger = {
  info: (event, context) => emit("info", event, context),
  warn: (event, context) => emit("warn", event, context),
  error: (event, error, context) =>
    emit("error", event, {
      ...context,
      error_message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
};
