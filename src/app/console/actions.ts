"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseNote } from "@/lib/cases/workflow";
import { getDatabase } from "@/db/client";
import { DEMO_MERCHANT_ID } from "@/db/config";
import { addCaseNote, transitionCase } from "@/db/console";
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

function done(caseId: string, error?: string): never {
  if (error) {
    logger.warn("validation_failed", {
      merchantId: DEMO_MERCHANT_ID,
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

  // A note alongside a transition is optional, but if given it must be valid.
  const rawNote = field(formData, "note").trim();
  let note: string | null = null;
  if (rawNote !== "") {
    const parsed = parseNote(rawNote);
    if (!parsed.ok) done(caseId, parsed.error);
    note = parsed.value;
  }

  const result = await transitionCase(
    getDatabase(),
    DEMO_MERCHANT_ID,
    caseId,
    to,
    note,
  );
  done(caseId, result.ok ? undefined : result.error);
}

export async function addNote(formData: FormData): Promise<void> {
  const caseId = field(formData, "case_id");
  const parsed = parseNote(field(formData, "note"));
  if (!parsed.ok) done(caseId, parsed.error);

  const result = await addCaseNote(
    getDatabase(),
    DEMO_MERCHANT_ID,
    caseId,
    parsed.value,
  );
  done(caseId, result.ok ? undefined : result.error);
}
