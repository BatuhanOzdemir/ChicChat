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
import {
  decideRouting,
  describeRouting,
  routingContext,
} from "@/lib/cases/routing";
import {
  genericErrorMessage,
  inboundSummary,
  outboundSummary,
  promptToMessage,
} from "@/lib/whatsapp";
import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";
import type { IntakeCase } from "@/lib/intake";
import { persistCase, type PersistCaseRouting } from "@/db/cases";
import { clientDatabase, type Database } from "@/db/database";
import { loadMerchantConfig, toIntakeConfig } from "@/db/config";
import { claimMessage } from "@/db/processed-messages";
import { loadRoutingRules } from "@/db/routing";
import { recordMessage } from "@/db/transcript";
import {
  deleteSession,
  loadSessionMeta,
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

/**
 * Decide where a finished case belongs (SPEC §3 → §9): load the category's
 * rules, evaluate them against what was captured, and describe the outcome for
 * the case timeline. Rules the merchant wrote are data, so an empty or
 * non-matching set is normal — the case then stays open and unrouted.
 */
async function routeCase(
  db: Database,
  merchantId: string,
  structured: IntakeCase,
  settings: Record<string, unknown>,
): Promise<PersistCaseRouting> {
  const rules = await loadRoutingRules(db, merchantId, structured.category);
  const decision = decideRouting(
    rules,
    routingContext({
      category: structured.category,
      subcategory: structured.subcategory,
      fields: structured.fields,
      settings,
    }),
  );
  return { ...decision, note: describeRouting(decision) };
}

/** Advance the conversation and persist the result. Throws on any failure. */
async function process(
  db: Database,
  merchantId: string,
  inbound: InboundMessage,
): Promise<{
  persistedCaseId: string | null;
  routing: PersistCaseRouting | null;
  reply: OutboundMessage;
}> {
  const merchantConfig = await loadMerchantConfig(db, merchantId);
  if (!merchantConfig) throw new Error(`merchant not found: ${merchantId}`);
  const config = toIntakeConfig(merchantConfig);

  const meta = await loadSessionMeta(db, merchantId, inbound.from);
  const existing = meta?.state ?? null;

  // Inside this transaction, and idempotent on the message id: if processing
  // fails and rolls back, the error path re-records it (SPEC §9).
  await recordMessage(db, {
    merchantId,
    customerWaId: inbound.from,
    direction: "inbound",
    kind: inbound.kind,
    body: inboundSummary(inbound),
    waMessageId: inbound.messageId,
  });

  // First contact shows the category list without consuming the greeting.
  const session =
    existing == null
      ? startIntake(config)
      : advance(config, existing, inbound.reply);

  let persistedCaseId: string | null = null;
  let routing: PersistCaseRouting | null = null;
  if (session.prompt.kind === "complete") {
    const structured = session.prompt.case;
    routing = await routeCase(db, merchantId, structured, {
      ...merchantConfig.settings,
    });
    persistedCaseId = await persistCase(db, {
      merchantId,
      customerWaId: inbound.from,
      categoryKey: structured.category,
      subcategoryKey: structured.subcategory,
      integrationTier: 0,
      // Where the intake began, so the console can report how long it took.
      intakeStartedAt: meta?.created_at ?? null,
      fields: structured.fields,
      routing,
    });
    await deleteSession(db, merchantId, inbound.from);
  } else {
    await saveSession(db, merchantId, inbound.from, session.state);
  }

  return {
    persistedCaseId,
    routing,
    reply: promptToMessage(session.prompt, inbound.from),
  };
}

/**
 * Add a sent message to the transcript. Called after the send succeeds, so the
 * transcript is what the customer actually received — and best-effort, because
 * failing to log a delivered reply must not trigger the error path and send the
 * customer a second, contradictory message.
 */
async function recordSent(
  deps: IntakeDeps,
  merchantId: string,
  inbound: InboundMessage,
  message: OutboundMessage,
  caseId: string | null,
  log: Logger,
): Promise<void> {
  try {
    await recordMessage(deps.db, {
      merchantId,
      customerWaId: inbound.from,
      caseId,
      direction: "outbound",
      kind: message.type,
      body: outboundSummary(message),
    });
  } catch (err) {
    log.error("unexpected_exception", err, {
      merchantId,
      correlationId: inbound.messageId,
      phone: inbound.from,
      during: "transcript_record",
    });
  }
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

    const { persistedCaseId, routing, reply } = outcome;
    if (persistedCaseId) {
      log.info("case_persisted", { ...context, case_id: persistedCaseId });
      if (routing) {
        log.info("routing_decision", {
          ...context,
          case_id: persistedCaseId,
          queue: routing.queue,
          priority: routing.priority,
          status: routing.status,
        });
      }
    }
    // Sent after commit: never promise the customer something uncommitted.
    await deps.send(reply);
    await recordSent(deps, merchantId, inbound, reply, persistedCaseId, log);
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
      const fallback = genericErrorMessage(inbound.from);
      await deps.send(fallback);
      // An agent reading this case needs to see what the customer sent and that
      // we answered with the generic line (§9). Re-recording the inbound is a
      // no-op unless its transaction rolled back.
      await recordMessage(deps.db, {
        merchantId,
        customerWaId: inbound.from,
        direction: "inbound",
        kind: inbound.kind,
        body: inboundSummary(inbound),
        waMessageId: inbound.messageId,
      });
      await recordSent(deps, merchantId, inbound, fallback, null, log);
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
