/**
 * Inbound WhatsApp orchestration (SPEC §§10–13).
 *
 * Lock the conversation; atomically claim the message, advance intake, persist
 * state and queue its reply. Deliver only after commit. Processing errors mark
 * the session errored; transport errors leave state intact and retain the reply.
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
  promptToMessage,
} from "@/lib/whatsapp";
import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";
import type { IntakeCase } from "@/lib/intake";
import { persistCase, type PersistCaseRouting } from "@/db/cases";
import { clientDatabase, type Database } from "@/db/database";
import { loadMerchantConfig, toIntakeConfig } from "@/db/config";
import { claimMessage } from "@/db/processed-messages";
import { loadRoutingRules } from "@/db/routing";
import { lockConversation } from "@/db/conversation-lock";
import { enqueueReply, type DeliveryChannel } from "@/db/outbox";
import { deliverReplies } from "./outbox";
import { redactText } from "@/lib/logging/mask";
import { savePhoto } from "@/db/media";
import type { Photo } from "./media";
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
  channel?: DeliveryChannel;
  deferDelivery?: boolean;
  beforeAdvance?: () => void;
  loadPhoto?: (mediaId: string) => Promise<Photo>;
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
  channel: DeliveryChannel,
  beforeAdvance?: () => void,
  loadPhoto?: (mediaId: string) => Promise<Photo>,
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
  beforeAdvance?.();
  if (inbound.kind === "image" && inbound.mediaId && loadPhoto) {
    await savePhoto(
      db,
      merchantId,
      inbound.from,
      inbound.mediaId,
      await loadPhoto(inbound.mediaId),
    );
  }
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
    await saveSession(db, merchantId, inbound.from, session.state, channel);
  }

  return {
    persistedCaseId,
    routing,
    reply: promptToMessage(
      session.prompt,
      inbound.from,
      merchantConfig.merchant.locale,
    ),
  };
}

/** Commit the state transition and its reply together; transport failures leave a retryable reply. */
export async function handleInbound(
  deps: IntakeDeps,
  merchantId: string,
  inbound: InboundMessage,
): Promise<IntakeResult> {
  const log = deps.logger ?? defaultLogger;
  const channel = deps.channel ?? "simulator";
  const context = {
    merchantId,
    correlationId: inbound.messageId,
    phone: inbound.from,
    kind: inbound.kind,
  };
  let outcome: Awaited<ReturnType<typeof process>> | null;
  try {
    outcome = await deps.db.transaction(async (tx) => {
      await lockConversation(tx, merchantId, inbound.from);
      const claimed = await claimMessage(
        tx,
        merchantId,
        inbound.messageId,
        inbound.from,
      );
      if (!claimed) return null;
      const result = await process(
        clientDatabase(tx),
        merchantId,
        inbound,
        channel,
        deps.beforeAdvance,
        deps.loadPhoto,
      );
      await enqueueReply(tx, {
        merchantId,
        phone: inbound.from,
        key: inbound.messageId,
        channel,
        message: result.reply,
        caseId: result.persistedCaseId,
      });
      return result;
    });
  } catch (err) {
    log.error("unexpected_exception", err, context);
    try {
      await deps.db.transaction(async (tx) => {
        await lockConversation(tx, merchantId, inbound.from);
        const merchantConfig = await loadMerchantConfig(tx, merchantId);
        // First-contact failures also need a visible error session.
        const existing = await loadSessionMeta(tx, merchantId, inbound.from);
        if (!existing) {
          const config = await loadMerchantConfig(tx, merchantId);
          if (!config) throw new Error("merchant unavailable");
          await saveSession(
            tx,
            merchantId,
            inbound.from,
            startIntake(toIntakeConfig(config)).state,
            channel,
          );
        }
        await setSessionStatus(
          tx,
          merchantId,
          inbound.from,
          "errored",
          redactText(err instanceof Error ? err.message : "processing failed"),
        );
        await recordMessage(tx, {
          merchantId,
          customerWaId: inbound.from,
          direction: "inbound",
          kind: inbound.kind,
          body: inboundSummary(inbound),
          waMessageId: inbound.messageId,
        });
        await enqueueReply(tx, {
          merchantId,
          phone: inbound.from,
          key: "error:" + inbound.messageId,
          channel,
          message: genericErrorMessage(
            inbound.from,
            merchantConfig?.merchant.locale,
          ),
        });
      });
      log.warn("session_errored", context);
      if (!deps.deferDelivery)
        await deliverReplies(
          deps.db,
          merchantId,
          inbound.from,
          deps.send,
          channel,
        );
    } catch (recoveryErr) {
      log.error("unexpected_exception", recoveryErr, {
        ...context,
        during: "error_recovery",
      });
    }
    return { persistedCaseId: null, duplicate: false, failed: true };
  }
  if (!outcome) log.info("message_skipped_duplicate", context);
  if (outcome?.persistedCaseId) {
    log.info("case_persisted", {
      ...context,
      case_id: outcome.persistedCaseId,
    });
    if (outcome.routing)
      log.info("routing_decision", { ...context, ...outcome.routing });
  }
  let failed = false;
  if (!deps.deferDelivery) {
    try {
      failed = (
        await deliverReplies(
          deps.db,
          merchantId,
          inbound.from,
          deps.send,
          channel,
          outcome === null,
        )
      ).failed;
    } catch (err) {
      failed = true;
      log.error("unexpected_exception", err, {
        ...context,
        during: "delivery",
      });
    }
  }
  return {
    persistedCaseId: outcome?.persistedCaseId ?? null,
    duplicate: outcome === null,
    failed,
  };
}
