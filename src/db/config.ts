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

/**
 * The seed's demo merchant. A **fixture id**, not a runtime default: since
 * Step 6 the app resolves its tenant from the inbound `phone_number_id` (the
 * webhook) or the console's merchant switcher, and nothing outside the seed and
 * the tests refers to this constant.
 */
export const DEMO_MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

export interface EditableField {
  id: string;
  key: string;
  label: string | null;
  type: string;
  required: boolean;
  enumValues: string[] | null;
  normalizeRule: string | null;
  sortOrder: number;
}

export interface EditableCategory {
  id: string;
  key: string;
  label: string;
  enabled: boolean;
  sortOrder: number;
  subcategories: { id: string; key: string; label: string }[];
  fields: EditableField[];
}

export interface MerchantSettings {
  return_window_days: number;
  refund_sla_days: number;
  auto_approve_threshold: number;
  order_id_regex: string | null;
  /** Customer silence before one gentle resume prompt (SPEC §11). */
  nudge_after_minutes: number;
  /** Silence before an unfinished intake is abandoned (SPEC §11). */
  abandon_after_hours: number;
  /** KVKK aydınlatma metni URL (SPEC §§8, 12). */
  kvkk_url: string | null;
  /** How long case data is kept before hard deletion (SPEC §12). */
  retention_months: number;
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

/** Merchants available to pick from (simulator selector, SPEC §7). */
export async function listMerchants(
  db: Queryable,
): Promise<{ id: string; name: string; locale: string; rtl: boolean }[]> {
  const { rows } = await db.query(
    `select id, name, locale, rtl from merchants order by name`,
  );
  return rows as { id: string; name: string; locale: string; rtl: boolean }[];
}

/**
 * Load the full editable config for a merchant (all categories, enabled or not).
 *
 * Exactly four queries regardless of taxonomy size — subcategories and field
 * defs are fetched for the whole merchant and grouped in memory, because this
 * runs on every inbound message (SPEC §10, RETROFIT R16).
 */
export async function loadMerchantConfig(
  db: Queryable,
  merchantId: string,
): Promise<EditableMerchantConfig | null> {
  const { rows: merchantRows } = await db.query(
    `select m.id, m.name, m.locale, m.rtl, m.currency,
            c.return_window_days, c.refund_sla_days, c.auto_approve_threshold,
            c.order_id_regex, c.nudge_after_minutes, c.abandon_after_hours,
            c.kvkk_url, c.retention_months
       from merchants m
       left join merchant_config c on c.merchant_id = m.id
      where m.id = $1`,
    [merchantId],
  );
  const row = merchantRows[0] as
    | (EditableMerchantConfig["merchant"] & {
        return_window_days: number | null;
        refund_sla_days: number | null;
        auto_approve_threshold: string | number | null;
        order_id_regex: string | null;
        nudge_after_minutes: number | null;
        abandon_after_hours: number | null;
        kvkk_url: string | null;
        retention_months: number | null;
      })
    | undefined;
  if (!row) return null;

  const merchant: EditableMerchantConfig["merchant"] = {
    id: row.id,
    name: row.name,
    locale: row.locale,
    rtl: row.rtl,
    currency: row.currency,
  };
  const settings: MerchantSettings = {
    return_window_days: row.return_window_days ?? 30,
    refund_sla_days: row.refund_sla_days ?? 14,
    auto_approve_threshold: Number(row.auto_approve_threshold ?? 0),
    order_id_regex: row.order_id_regex ?? null,
    nudge_after_minutes: row.nudge_after_minutes ?? 5,
    abandon_after_hours: row.abandon_after_hours ?? 24,
    kvkk_url: row.kvkk_url ?? null,
    retention_months: row.retention_months ?? 12,
  };

  const { rows: catRows } = await db.query(
    `select id, key, label, enabled, sort_order
       from categories where merchant_id = $1 order by sort_order, key`,
    [merchantId],
  );
  const { rows: subRows } = await db.query(
    `select sc.category_id, sc.id, sc.key, sc.label
       from subcategories sc
       join categories c on c.id = sc.category_id
      where c.merchant_id = $1
      order by sc.sort_order, sc.key`,
    [merchantId],
  );
  const { rows: fieldRows } = await db.query(
    `select fd.category_id, fd.id, fd.key, fd.label, fd.type, fd.required,
            fd.enum_values, fd.normalize_rule, fd.sort_order
       from field_defs fd
       join categories c on c.id = fd.category_id
      where c.merchant_id = $1
      order by fd.sort_order, fd.key`,
    [merchantId],
  );

  const subsByCategory = new Map<
    string,
    { id: string; key: string; label: string }[]
  >();
  for (const s of subRows as {
    category_id: string;
    id: string;
    key: string;
    label: string;
  }[]) {
    const list = subsByCategory.get(s.category_id) ?? [];
    list.push({ id: s.id, key: s.key, label: s.label });
    subsByCategory.set(s.category_id, list);
  }

  const fieldsByCategory = new Map<string, EditableField[]>();
  for (const f of fieldRows as {
    category_id: string;
    id: string;
    key: string;
    label: string | null;
    type: string;
    required: boolean;
    enum_values: string[] | null;
    normalize_rule: string | null;
    sort_order: number;
  }[]) {
    const list = fieldsByCategory.get(f.category_id) ?? [];
    list.push({
      id: f.id,
      key: f.key,
      label: f.label ?? null,
      type: f.type,
      required: f.required,
      enumValues: f.enum_values ?? null,
      normalizeRule: f.normalize_rule ?? null,
      sortOrder: f.sort_order,
    });
    fieldsByCategory.set(f.category_id, list);
  }

  const categories: EditableCategory[] = [];
  for (const c of catRows as {
    id: string;
    key: string;
    label: string;
    enabled: boolean;
    sort_order: number;
  }[]) {
    const subcategories = subsByCategory.get(c.id) ?? [];
    const fields = fieldsByCategory.get(c.id) ?? [];
    categories.push({
      id: c.id,
      key: c.key,
      label: c.label,
      enabled: c.enabled,
      sortOrder: c.sort_order,
      subcategories,
      fields,
    });
  }

  return { merchant, settings, categories };
}

/**
 * The intake machine's view of an already-loaded config — enabled categories
 * only. Separate from the load so a caller that also needs the settings (e.g.
 * routing rules resolving `ref` values) does not query twice per message.
 */
export function toIntakeConfig(config: EditableMerchantConfig): IntakeConfig {
  return {
    orderIdRegex: config.settings.order_id_regex ?? undefined,
    kvkkUrl: config.settings.kvkk_url ?? undefined,
    categories: config.categories
      .filter((c) => c.enabled)
      .map((c) => ({
        key: c.key,
        label: c.label,
        subcategories: c.subcategories.map((s) => ({
          key: s.key,
          label: s.label,
        })),
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

/** Load the merchant config and reduce it to the intake machine's view. */
export async function buildIntakeConfig(
  db: Queryable,
  merchantId: string,
): Promise<IntakeConfig> {
  const config = await loadMerchantConfig(db, merchantId);
  if (!config) throw new Error(`merchant not found: ${merchantId}`);
  return toIntakeConfig(config);
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
