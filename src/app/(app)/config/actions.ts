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
import { currentMerchantId } from "@/server/merchant/current";
import { logger } from "@/server/logging/logger";

/**
 * Server actions for the taxonomy editor (SPEC §8).
 *
 * Every action validates its form at the boundary with a pure parser
 * (Handbook §5) and returns validation messages to the submitting form
 * without navigating away or discarding other edits.
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

export interface ConfigActionResult {
  error?: string;
}

/** Refresh saved data in place, preserving unrelated form drafts. */
function done(error?: string, merchantId?: string): ConfigActionResult {
  if (error) {
    logger.warn("validation_failed", { merchantId, error });
    return { error };
  }
  revalidatePath("/config");
  return {};
}

function reportWrite(
  result: WriteResult,
  merchantId: string,
): ConfigActionResult {
  return result.ok ? done() : done(result.error, merchantId);
}

/**
 * The merchant every write below is scoped to (Step 6). It comes from the
 * switcher's cookie, never from the submitted form, so a form cannot be
 * retargeted at another tenant — and the `db/taxonomy` writers check ownership
 * of the row as well.
 */
async function tenant(): Promise<string> {
  const merchantId = await currentMerchantId(getDatabase());
  if (!merchantId) redirect("/login");
  return merchantId;
}

export async function savePolicy(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parsePolicy(values(formData));
  if (!parsed.ok) return done(parsed.error, merchantId);
  await updatePolicy(getDatabase(), merchantId, parsed.value);
  return done();
}

export async function addCategory(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseNamed(values(formData), "category");
  if (!parsed.ok) return done(parsed.error, merchantId);
  return reportWrite(
    await createCategory(getDatabase(), merchantId, parsed.value),
    merchantId,
  );
}

export async function saveCategory(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseNamed(values(formData), "category");
  if (!parsed.ok) return done(parsed.error, merchantId);
  await updateCategory(getDatabase(), merchantId, id(formData, "id"), {
    label: parsed.value.label,
    sortOrder: parsed.value.sortOrder,
    enabled: formData.get("enabled") !== null,
  });
  return done();
}

export async function removeCategory(
  formData: FormData,
): Promise<ConfigActionResult> {
  await deleteCategory(getDatabase(), await tenant(), id(formData, "id"));
  return done();
}

export async function addSubcategory(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseNamed(values(formData), "subcategory");
  if (!parsed.ok) return done(parsed.error, merchantId);
  return reportWrite(
    await createSubcategory(
      getDatabase(),
      merchantId,
      id(formData, "category_id"),
      parsed.value,
    ),
    merchantId,
  );
}

export async function removeSubcategory(
  formData: FormData,
): Promise<ConfigActionResult> {
  await deleteSubcategory(getDatabase(), await tenant(), id(formData, "id"));
  return done();
}

export async function addField(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseField(values(formData));
  if (!parsed.ok) return done(parsed.error, merchantId);
  return reportWrite(
    await createField(
      getDatabase(),
      merchantId,
      id(formData, "category_id"),
      parsed.value,
    ),
    merchantId,
  );
}

export async function saveField(
  formData: FormData,
): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseField(values(formData));
  if (!parsed.ok) return done(parsed.error, merchantId);
  await updateField(
    getDatabase(),
    merchantId,
    id(formData, "id"),
    parsed.value,
  );
  return done();
}

export async function removeField(
  formData: FormData,
): Promise<ConfigActionResult> {
  await deleteField(getDatabase(), await tenant(), id(formData, "id"));
  return done();
}

export async function addRule(formData: FormData): Promise<ConfigActionResult> {
  const merchantId = await tenant();
  const parsed = parseRule(values(formData));
  if (!parsed.ok) return done(parsed.error, merchantId);
  return reportWrite(
    await createRule(
      getDatabase(),
      merchantId,
      id(formData, "category_id"),
      parsed.value,
    ),
    merchantId,
  );
}

export async function removeRule(
  formData: FormData,
): Promise<ConfigActionResult> {
  await deleteRule(getDatabase(), await tenant(), id(formData, "id"));
  return done();
}
