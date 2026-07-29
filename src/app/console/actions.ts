"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseNote } from "@/lib/cases/workflow";
import { getDatabase } from "@/db/client";
import { addCaseNote, transitionCase } from "@/db/console";
import { currentMerchantId } from "@/server/merchant/current";
import { logger } from "@/server/logging/logger";

/**
 * The two things an agent can do to a case (SPEC §9): move its status and leave
 * an internal note. Both validate at the boundary and report problems back
 * through `?error=` rather than throwing at the agent, matching /config.
 *
 * Replying to the customer from ChicChat is an explicit non-goal in v0.2, so
 * nothing here sends a WhatsApp message.
 */

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

function done(caseId: string, error?: string, merchantId?: string): never {
  if (error) {
    logger.warn("validation_failed", {
      merchantId,
      case_id: caseId,
      error,
    });
    redirect(`/console/${caseId}?error=${encodeURIComponent(error)}`);
  }
  revalidatePath(`/console/${caseId}`);
  revalidatePath("/console");
  redirect(`/console/${caseId}`);
}

export async function changeStatus(formData: FormData): Promise<void> {
  const caseId = field(formData, "case_id");
  const to = field(formData, "to");
  const db = getDatabase();

  // The tenant comes from the switcher, never from the form, so a case id
  // belonging to another merchant simply is not found (Step 6).
  const merchantId = await currentMerchantId(db);
  if (!merchantId) done(caseId, "no merchant selected");

  // A note alongside a transition is optional, but if given it must be valid.
  const rawNote = field(formData, "note").trim();
  let note: string | null = null;
  if (rawNote !== "") {
    const parsed = parseNote(rawNote);
    if (!parsed.ok) done(caseId, parsed.error, merchantId);
    note = parsed.value;
  }

  const result = await transitionCase(db, merchantId, caseId, to, note);
  done(caseId, result.ok ? undefined : result.error, merchantId);
}

export async function addNote(formData: FormData): Promise<void> {
  const caseId = field(formData, "case_id");
  const db = getDatabase();

  const merchantId = await currentMerchantId(db);
  if (!merchantId) done(caseId, "no merchant selected");

  const parsed = parseNote(field(formData, "note"));
  if (!parsed.ok) done(caseId, parsed.error, merchantId);

  const result = await addCaseNote(db, merchantId, caseId, parsed.value);
  done(caseId, result.ok ? undefined : result.error, merchantId);
}
