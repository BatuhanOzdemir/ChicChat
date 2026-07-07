/**
 * Merchant configuration data layer (CLAUDE.md Step 7).
 *
 * Reads/writes the merchant-editable parts of the taxonomy — enabled
 * categories, labels, required-field flags, return window / refund SLA — and
 * bridges the DB into the Step 5 `IntakeConfig`, so config edits visibly change
 * what the intake machine asks for. Driver-decoupled via `Queryable`.
 */
import type { IntakeConfig, FieldType } from "../lib/intake";
import type { Queryable } from "./cases";

/** The demo merchant the config UI edits (no auth/merchant-switching in Phase A). */
export const DEMO_MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

export interface EditableField {
  id: string;
  key: string;
  type: string;
  required: boolean;
  enumValues: string[] | null;
  normalizeRule: string | null;
}

export interface EditableCategory {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  subcategories: { key: string; label: string }[];
  fields: EditableField[];
}

export interface MerchantSettings {
  return_window_days: number;
  refund_sla_days: number;
  auto_approve_threshold: number;
  order_id_regex: string | null;
}

export interface EditableMerchantConfig {
  merchant: {
    id: string;
    name: string;
    locale: string;
    rtl: boolean;
    currency: string;
  };
  settings: MerchantSettings;
  categories: EditableCategory[];
}

/** Load the full editable config for a merchant (all categories, enabled or not). */
export async function loadMerchantConfig(
  db: Queryable,
  merchantId: string,
): Promise<EditableMerchantConfig | null> {
  const { rows: merchantRows } = await db.query(
    `select id, name, locale, rtl, currency from merchants where id = $1`,
    [merchantId],
  );
  const merchant = merchantRows[0] as
    | EditableMerchantConfig["merchant"]
    | undefined;
  if (!merchant) return null;

  const { rows: settingsRows } = await db.query(
    `select return_window_days, refund_sla_days, auto_approve_threshold, order_id_regex
       from merchant_config where merchant_id = $1`,
    [merchantId],
  );
  const rawSettings = settingsRows[0] as
    | (Omit<MerchantSettings, "auto_approve_threshold"> & {
        auto_approve_threshold: string | number;
      })
    | undefined;
  const settings: MerchantSettings = {
    return_window_days: rawSettings?.return_window_days ?? 30,
    refund_sla_days: rawSettings?.refund_sla_days ?? 14,
    auto_approve_threshold: Number(rawSettings?.auto_approve_threshold ?? 0),
    order_id_regex: rawSettings?.order_id_regex ?? null,
  };

  const { rows: catRows } = await db.query(
    `select id, key, label, enabled, sort_order
       from categories where merchant_id = $1 order by sort_order, key`,
    [merchantId],
  );
  const categories: EditableCategory[] = [];
  for (const c of catRows as {
    id: string;
    key: string;
    label: string;
    enabled: boolean;
    sort_order: number;
  }[]) {
    const { rows: subRows } = await db.query(
      `select key, label from subcategories where category_id = $1 order by sort_order, key`,
      [c.id],
    );
    const { rows: fieldRows } = await db.query(
      `select id, key, type, required, enum_values, normalize_rule
         from field_defs where category_id = $1 order by key`,
      [c.id],
    );
    const fields: EditableField[] = (
      fieldRows as {
        id: string;
        key: string;
        type: string;
        required: boolean;
        enum_values: string[] | null;
        normalize_rule: string | null;
      }[]
    ).map((f) => ({
      id: f.id,
      key: f.key,
      type: f.type,
      required: f.required,
      enumValues: f.enum_values ?? null,
      normalizeRule: f.normalize_rule ?? null,
    }));
    categories.push({
      id: c.id,
      key: c.key,
      label: c.label,
      enabled: c.enabled,
      sortOrder: c.sort_order,
      subcategories: subRows as { key: string; label: string }[],
      fields,
    });
  }

  return { merchant, settings, categories };
}

/** Build the Step 5 IntakeConfig from the DB — enabled categories only. */
export async function buildIntakeConfig(
  db: Queryable,
  merchantId: string,
): Promise<IntakeConfig> {
  const config = await loadMerchantConfig(db, merchantId);
  if (!config) throw new Error(`merchant not found: ${merchantId}`);

  return {
    orderIdRegex: config.settings.order_id_regex ?? undefined,
    categories: config.categories
      .filter((c) => c.enabled)
      .map((c) => ({
        key: c.key,
        label: c.label,
        subcategories: c.subcategories,
        fields: c.fields.map((f) => ({
          key: f.key,
          type: f.type as FieldType,
          required: f.required,
          enumValues: f.enumValues,
          normalizeRule: f.normalizeRule,
        })),
      })),
  };
}

// --- Mutations (each is a single-column edit used by the config UI) ---------

export async function updateMerchantSettings(
  db: Queryable,
  merchantId: string,
  settings: { return_window_days: number; refund_sla_days: number },
): Promise<void> {
  await db.query(
    `update merchant_config
        set return_window_days = $2, refund_sla_days = $3
      where merchant_id = $1`,
    [merchantId, settings.return_window_days, settings.refund_sla_days],
  );
}

export async function setCategoryEnabled(
  db: Queryable,
  categoryId: string,
  enabled: boolean,
): Promise<void> {
  await db.query(`update categories set enabled = $2 where id = $1`, [
    categoryId,
    enabled,
  ]);
}

export async function updateCategoryLabel(
  db: Queryable,
  categoryId: string,
  label: string,
): Promise<void> {
  await db.query(`update categories set label = $2 where id = $1`, [
    categoryId,
    label,
  ]);
}

export async function setFieldRequired(
  db: Queryable,
  fieldDefId: string,
  required: boolean,
): Promise<void> {
  await db.query(`update field_defs set required = $2 where id = $1`, [
    fieldDefId,
    required,
  ]);
}
