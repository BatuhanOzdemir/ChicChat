"use server";

import { revalidatePath } from "next/cache";
import { getPool } from "@/db/client";
import {
  DEMO_MERCHANT_ID,
  loadMerchantConfig,
  setCategoryEnabled,
  setFieldRequired,
  updateCategoryLabel,
  updateMerchantSettings,
} from "@/db/config";

function toInt(value: FormDataEntryValue | null, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Persist every edit from the config form, then revalidate the page. */
export async function saveConfig(formData: FormData): Promise<void> {
  const pool = getPool();
  const config = await loadMerchantConfig(pool, DEMO_MERCHANT_ID);
  if (!config) return;

  await updateMerchantSettings(pool, DEMO_MERCHANT_ID, {
    return_window_days: toInt(
      formData.get("settings.return_window_days"),
      config.settings.return_window_days,
    ),
    refund_sla_days: toInt(
      formData.get("settings.refund_sla_days"),
      config.settings.refund_sla_days,
    ),
  });

  for (const category of config.categories) {
    const enabled = formData.has(`category.${category.id}.enabled`);
    const label =
      formData.get(`category.${category.id}.label`)?.toString().trim() ||
      category.label;
    await setCategoryEnabled(pool, category.id, enabled);
    await updateCategoryLabel(pool, category.id, label);

    for (const field of category.fields) {
      const required = formData.has(`field.${field.id}.required`);
      await setFieldRequired(pool, field.id, required);
    }
  }

  revalidatePath("/config");
}
