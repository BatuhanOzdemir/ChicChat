"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  parseField,
  parseNamed,
  parsePolicy,
  parseRule,
  type FormValues,
} from "@/lib/config/forms";
import { getDatabase } from "@/db/client";
import { DEMO_MERCHANT_ID } from "@/db/config";
import {
  createCategory,
  createField,
  createRule,
  createSubcategory,
  deleteCategory,
  deleteField,
  deleteRule,
  deleteSubcategory,
  updateCategory,
  updateField,
  updatePolicy,
  type WriteResult,
} from "@/db/taxonomy";
import { logger } from "@/server/logging/logger";

/**
 * Server actions for the taxonomy editor (SPEC §8).
 *
 * Every action validates its form at the boundary with a pure parser
 * (Handbook §5) and reports problems back to the page through a `?error=`
 * message rather than throwing at the user.
 */

function values(formData: FormData): FormValues {
  const out: FormValues = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function id(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

/** Finish an action: report a problem, or refresh the editor. */
function done(error?: string): never {
  if (error) {
    logger.warn("validation_failed", { merchantId: DEMO_MERCHANT_ID, error });
    redirect(`/config?error=${encodeURIComponent(error)}`);
  }
  revalidatePath("/config");
  redirect("/config");
}

function reportWrite(result: WriteResult): never {
  return result.ok ? done() : done(result.error);
}

export async function savePolicy(formData: FormData): Promise<void> {
  const parsed = parsePolicy(values(formData));
  if (!parsed.ok) done(parsed.error);
  await updatePolicy(getDatabase(), DEMO_MERCHANT_ID, parsed.value);
  done();
}

export async function addCategory(formData: FormData): Promise<void> {
  const parsed = parseNamed(values(formData), "category");
  if (!parsed.ok) done(parsed.error);
  reportWrite(
    await createCategory(getDatabase(), DEMO_MERCHANT_ID, parsed.value),
  );
}

export async function saveCategory(formData: FormData): Promise<void> {
  const parsed = parseNamed(values(formData), "category");
  if (!parsed.ok) done(parsed.error);
  await updateCategory(getDatabase(), DEMO_MERCHANT_ID, id(formData, "id"), {
    label: parsed.value.label,
    sortOrder: parsed.value.sortOrder,
    enabled: formData.get("enabled") !== null,
  });
  done();
}

export async function removeCategory(formData: FormData): Promise<void> {
  await deleteCategory(getDatabase(), DEMO_MERCHANT_ID, id(formData, "id"));
  done();
}

export async function addSubcategory(formData: FormData): Promise<void> {
  const parsed = parseNamed(values(formData), "subcategory");
  if (!parsed.ok) done(parsed.error);
  reportWrite(
    await createSubcategory(
      getDatabase(),
      DEMO_MERCHANT_ID,
      id(formData, "category_id"),
      parsed.value,
    ),
  );
}

export async function removeSubcategory(formData: FormData): Promise<void> {
  await deleteSubcategory(getDatabase(), DEMO_MERCHANT_ID, id(formData, "id"));
  done();
}

export async function addField(formData: FormData): Promise<void> {
  const parsed = parseField(values(formData));
  if (!parsed.ok) done(parsed.error);
  reportWrite(
    await createField(
      getDatabase(),
      DEMO_MERCHANT_ID,
      id(formData, "category_id"),
      parsed.value,
    ),
  );
}

export async function saveField(formData: FormData): Promise<void> {
  const parsed = parseField(values(formData));
  if (!parsed.ok) done(parsed.error);
  await updateField(
    getDatabase(),
    DEMO_MERCHANT_ID,
    id(formData, "id"),
    parsed.value,
  );
  done();
}

export async function removeField(formData: FormData): Promise<void> {
  await deleteField(getDatabase(), DEMO_MERCHANT_ID, id(formData, "id"));
  done();
}

export async function addRule(formData: FormData): Promise<void> {
  const parsed = parseRule(values(formData));
  if (!parsed.ok) done(parsed.error);
  reportWrite(
    await createRule(
      getDatabase(),
      DEMO_MERCHANT_ID,
      id(formData, "category_id"),
      parsed.value,
    ),
  );
}

export async function removeRule(formData: FormData): Promise<void> {
  await deleteRule(getDatabase(), DEMO_MERCHANT_ID, id(formData, "id"));
  done();
}
