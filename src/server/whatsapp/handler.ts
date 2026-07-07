/**
 * Inbound WhatsApp orchestration (CLAUDE.md Step 8): map a real inbound message
 * onto the Step 5 intake machine, persist the session between messages, reply
 * with the next List Message / prompt, and persist a Tier-0 case on completion.
 *
 * `send` and `db` are injected so this is testable without Meta or a running
 * Next.js server.
 */
import { advance, startIntake } from "@/lib/intake";
import { promptToMessage } from "@/lib/whatsapp";
import type { InboundMessage, OutboundMessage } from "@/lib/whatsapp";
import type { Queryable } from "@/db/cases";
import { persistCase } from "@/db/cases";
import { buildIntakeConfig } from "@/db/config";
import { deleteSession, loadSession, saveSession } from "@/db/sessions";

export interface IntakeDeps {
  db: Queryable;
  send: (message: OutboundMessage) => Promise<void>;
}

export async function handleInbound(
  deps: IntakeDeps,
  merchantId: string,
  inbound: InboundMessage,
): Promise<void> {
  const config = await buildIntakeConfig(deps.db, merchantId);
  const existing = await loadSession(deps.db, merchantId, inbound.from);

  // First contact starts a fresh intake (shows the category list) without
  // consuming the greeting; otherwise fold their reply into the machine.
  const session =
    existing == null
      ? startIntake(config)
      : advance(config, existing, inbound.reply);

  if (session.prompt.kind === "complete") {
    const structured = session.prompt.case;
    await persistCase(deps.db, {
      merchantId,
      customerWaId: inbound.from,
      categoryKey: structured.category,
      subcategoryKey: structured.subcategory,
      integrationTier: 0,
      fields: structured.fields,
    });
    await deleteSession(deps.db, merchantId, inbound.from);
  } else {
    await saveSession(deps.db, merchantId, inbound.from, session.state);
  }

  await deps.send(promptToMessage(session.prompt, inbound.from));
}
