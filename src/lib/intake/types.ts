/**
 * Intake state-machine types (CLAUDE.md Step 5 / SPEC.md §0.4, §6).
 *
 * Taxonomy-driven: category -> subcategory -> required fields -> case. The
 * config shapes mirror the seeded taxonomy (categories / subcategories /
 * field_defs). Tier-0: no integration, so item_ref is captured as text (§6.4).
 */

export type FieldType = "string" | "enum" | "media" | "ref";

export interface FieldDef {
  key: string;
  type: FieldType;
  required: boolean;
  label?: string;
  /** Allowed values for enum fields; null/empty means free text (runtime-constrained). */
  enumValues?: string[] | null;
  /** Named normalization rule, e.g. "order_number". */
  normalizeRule?: string | null;
}

export interface Option {
  key: string;
  label: string;
}

export interface CategoryDef {
  key: string;
  label: string;
  subcategories: Option[];
  fields: FieldDef[];
}

export interface IntakeConfig {
  categories: CategoryDef[];
  /** merchant_config.order_id_regex — applied to order_number fields. */
  orderIdRegex?: string;
}

export interface CapturedField {
  raw: string;
  normalized: string | null;
  valid: boolean;
}

export type IntakeStatus =
  | "selecting_category"
  | "selecting_subcategory"
  | "collecting_fields"
  | "complete";

export interface IntakeState {
  status: IntakeStatus;
  categoryKey?: string;
  subcategoryKey?: string;
  /** The field key the machine is currently waiting on an answer for. */
  pendingFieldKey?: string;
  fields: Record<string, CapturedField>;
  /** Raw fields pre-extracted by a classifier, folded in once collection starts. */
  pendingInitial: Record<string, string>;
}

/** The clean, complete structured case the machine assembles (Tier 0). */
export interface IntakeCase {
  category: string;
  subcategory: string | null;
  integration_tier: 0;
  fields: { key: string; raw: string; normalized: string | null }[];
}

export type Prompt =
  | { kind: "select_category"; options: Option[]; retry: boolean }
  | {
      kind: "select_subcategory";
      category: string;
      options: Option[];
      retry: boolean;
    }
  /** Free-form answer (string, media, ref, or an enum with no fixed values). */
  | { kind: "request_field"; field: FieldDef; retry: boolean }
  /**
   * An enum field with configured values: always offered as a tappable list,
   * never as a free-text question (SPEC §5).
   */
  | {
      kind: "select_field";
      field: FieldDef;
      options: Option[];
      retry: boolean;
    }
  | { kind: "complete"; case: IntakeCase };

export interface IntakeSession {
  state: IntakeState;
  prompt: Prompt;
}
