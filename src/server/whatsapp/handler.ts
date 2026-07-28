/**
 * Inbound WhatsApp orchestration (SPEC §§10–13).
 *
 * Responsibilities, in order: claim the message id so duplicate deliveries are
 * skipped (§11), advance the Step 5 intake machine, persist session or case
 * (atomically, §11), reply, and — if anything throws — send a generic message,
 * mark the session `errored`, and emit one correlated structured log line (§13).
 *
 * `db`, `send` and `logger` are injected so this is testable without Meta.
 */
import { advance, startIntake } from "@/lib/intake";
import { genericErrorMessage, promptToMessage } from "@/lib/whatsapp";
import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";
import { persistCase } from "@/db/cases";
import { clientDatabase, type Database } from "@/db/database";
import { buildIntakeConfig } from "@/db/config";
import { claimMessage } from "@/db/processed-messages";
import {
  deleteSession,
  loadSession,
  saveSession,
  setSessionStatus,
} from "@/db/sessions";
import { logger as defaultLogger, type Logger } from "@/server/logging/logger";

export interface IntakeDeps {
  db: Database;
  send: (message: OutboundMessage) => Promise<void>;
  logger?: Logger;
}

/** Outcome of handling one inbound message. */
export interface IntakeResult {
  /** Set when this message completed the intake and a case was written. */
  persistedCaseId: string | null;
  /** True when the message was a duplicate delivery and was skipped. */
  duplicate: boolean;
  /** True when processing failed and the generic reply was sent. */
  failed: boolean;
}

/** Advance the conversation and persist the result. Throws on any failure. */
async function process(
  db: Database,
  merchantId: string,
  inbound: InboundMessage,
): Promise<{ persistedCaseId: string | null; reply: OutboundMessage }> {
  const config = await buildIntakeConfig(db, merchantId);
  const existing = await loadSession(db, merchantId, inbound.from);

  // First contact shows the category list without consuming the greeting.
  const session =
    existing == null
      ? startIntake(config)
      : advance(config, existing, inbound.reply);

  let persistedCaseId: string | null = null;
  if (session.prompt.kind === "complete") {
    const structured = session.prompt.case;
    persistedCaseId = await persistCase(db, {
      merchantId,
      customerWaId: inbound.from,
      categoryKey: structured.category,
      subcategoryKey: structured.subcategory,
      integrationTier: 0,
      fields: structured.fields,
    });
    await deleteSession(db, merchantId, inbound.from);
  } else {
    await saveSession(db, merchantId, inbound.from, session.state);
  }

  return {
    persistedCaseId,
    reply: promptToMessage(session.prompt, inbound.from),
  };
}

export async function handleInbound(
  deps: IntakeDeps,
  merchantId: string,
  inbound: InboundMessage,
): Promise<IntakeResult> {
  const log = deps.logger ?? defaultLogger;
  const context = {
    merchantId,
    correlationId: inbound.messageId,
    phone: inbound.from,
    kind: inbound.kind,
  };

  try {
    // Claim and processing share one transaction, so a duplicate delivery is
    // skipped (SPEC §11) while a *failed* message releases its claim and can be
    // retried, and no partial case can survive a mid-write failure (§11/§13).
    const outcome = await deps.db.transaction(async (tx) => {
      const claimed = await claimMessage(tx, merchantId, inbound.messageId);
      if (!claimed) return null;
      return process(clientDatabase(tx), merchantId, inbound);
    });

    if (outcome === null) {
      log.info("message_skipped_duplicate", context);
      return { persistedCaseId: null, duplicate: true, failed: false };
    }

    const { persistedCaseId, reply } = outcome;
    if (persistedCaseId) {
      log.info("case_persisted", { ...context, case_id: persistedCaseId });
    }
    // Sent after commit: never promise the customer something uncommitted.
    await deps.send(reply);
    return { persistedCaseId, duplicate: false, failed: false };
  } catch (err) {
    // Handler boundary (SPEC §13): the conversation must never die silently.
    log.error("unexpected_exception", err, context);
    const message = err instanceof Error ? err.message : String(err);
    try {
      await setSessionStatus(
        deps.db,
        merchantId,
        inbound.from,
        "errored",
        message,
      );
      log.warn("session_errored", context);
      await deps.send(genericErrorMessage(inbound.from));
    } catch (recoveryErr) {
      // Nothing more we can do; make the failed recovery visible too.
      log.error("unexpected_exception", recoveryErr, {
        ...context,
        during: "error_recovery",
      });
    }
    return { persistedCaseId: null, duplicate: false, failed: true };
  }
}
