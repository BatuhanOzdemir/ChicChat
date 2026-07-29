/**
 * Config-editor input parsing (SPEC §8, Handbook §5).
 *
 * Pure: takes plain records (a FormData is turned into one by the caller) and
 * returns discriminated results, so every editor boundary is validated before
 * anything reaches the database — and the rules are unit-testable.
 */
import { isPriority, PRIORITIES } from "../cases/workflow";
import { isValidKey, slugifyKey } from "./keys";

export { PRIORITIES };

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type FormValues = Record<string, string | undefined>;

export const FIELD_TYPES = ["string", "enum", "media", "ref"] as const;
export type EditableFieldType = (typeof FIELD_TYPES)[number];

/**
 * Normalization rules a merchant can attach to a field. Offered as a choice so
 * nobody has to guess the string — a mistyped rule silently means "no
 * normalization", which is how an order number ends up stored raw.
 */
export const NORMALIZE_RULES = ["order_number"] as const;
export type NormalizeRule = (typeof NORMALIZE_RULES)[number];

export const ACTION_TYPES = [
  "route",
  "auto_reply",
  "request_info",
  "escalate",
] as const;
export type EditableActionType = (typeof ACTION_TYPES)[number];

function text(values: FormValues, name: string): string {
  return (values[name] ?? "").trim();
}

function int(
  values: FormValues,
  name: string,
  fallback: number,
): number | null {
  const raw = text(values, name);
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// --- Policy ----------------------------------------------------------------

export interface PolicyInput {
  returnWindowDays: number;
  refundSlaDays: number;
  nudgeAfterMinutes: number;
  abandonAfterHours: number;
  retentionMonths: number;
  kvkkUrl: string | null;
  orderIdRegex: string | null;
}

export function parsePolicy(values: FormValues): ParseResult<PolicyInput> {
  const numbers = {
    returnWindowDays: int(values, "return_window_days", 30),
    refundSlaDays: int(values, "refund_sla_days", 14),
    nudgeAfterMinutes: int(values, "nudge_after_minutes", 5),
    abandonAfterHours: int(values, "abandon_after_hours", 24),
    retentionMonths: int(values, "retention_months", 12),
  };
  for (const [key, value] of Object.entries(numbers)) {
    if (value === null) {
      return { ok: false, error: `${key} must be a non-negative whole number` };
    }
  }
  if (numbers.nudgeAfterMinutes === 0) {
    return { ok: false, error: "nudge_after_minutes must be at least 1" };
  }
  if (numbers.abandonAfterHours === 0) {
    return { ok: false, error: "abandon_after_hours must be at least 1" };
  }

  const kvkkUrl = text(values, "kvkk_url");
  if (kvkkUrl !== "" && !/^https?:\/\/\S+$/.test(kvkkUrl)) {
    return { ok: false, error: "kvkk_url must be an http(s) URL" };
  }

  const orderIdRegex = text(values, "order_id_regex");
  if (orderIdRegex !== "") {
    try {
      new RegExp(orderIdRegex);
    } catch {
      return { ok: false, error: "order_id_regex is not a valid expression" };
    }
  }

  return {
    ok: true,
    value: {
      ...(numbers as { [K in keyof typeof numbers]: number }),
      kvkkUrl: kvkkUrl === "" ? null : kvkkUrl,
      orderIdRegex: orderIdRegex === "" ? null : orderIdRegex,
    },
  };
}

// --- Categories & subcategories --------------------------------------------

export interface NamedInput {
  key: string;
  label: string;
  sortOrder: number;
}

/** Shared parser for a category or subcategory: label required, key derived. */
export function parseNamed(
  values: FormValues,
  what: "category" | "subcategory",
): ParseResult<NamedInput> {
  const label = text(values, "label");
  if (label === "") return { ok: false, error: `${what} label is required` };

  const provided = text(values, "key");
  const key = provided === "" ? slugifyKey(label) : slugifyKey(provided);
  if (!isValidKey(key)) {
    return {
      ok: false,
      error: `could not derive a valid key from "${label}" — add a key with letters`,
    };
  }

  const sortOrder = int(values, "sort_order", 0);
  if (sortOrder === null) {
    return { ok: false, error: "sort_order must be a non-negative number" };
  }

  return { ok: true, value: { key, label, sortOrder } };
}

// --- Fields ----------------------------------------------------------------

export interface FieldInput {
  key: string;
  label: string | null;
  type: EditableFieldType;
  required: boolean;
  enumValues: string[] | null;
  normalizeRule: string | null;
  sortOrder: number;
}

export function parseField(values: FormValues): ParseResult<FieldInput> {
  const label = text(values, "label");
  const provided = text(values, "key");
  const key = provided === "" ? slugifyKey(label) : slugifyKey(provided);
  if (!isValidKey(key)) {
    return { ok: false, error: "field key is required (letters, digits, _)" };
  }

  const type = text(values, "type") as EditableFieldType;
  if (!FIELD_TYPES.includes(type)) {
    return {
      ok: false,
      error: `field type must be one of ${FIELD_TYPES.join("|")}`,
    };
  }

  // One value per line, or comma separated — merchants type both.
  const rawValues = text(values, "enum_values");
  const enumValues =
    rawValues === ""
      ? null
      : rawValues
          .split(/[\n,]/)
          .map((v) => slugifyKey(v))
          .filter((v) => v !== "");

  if (type === "enum" && enumValues && enumValues.length > 10) {
    // WhatsApp list messages cap at 10 rows (SPEC §6).
    return { ok: false, error: "an enum field can offer at most 10 values" };
  }

  const sortOrder = int(values, "sort_order", 0);
  if (sortOrder === null) {
    return { ok: false, error: "sort_order must be a non-negative number" };
  }

  const normalizeRule = text(values, "normalize_rule");
  if (
    normalizeRule !== "" &&
    !NORMALIZE_RULES.includes(normalizeRule as NormalizeRule)
  ) {
    return {
      ok: false,
      error: `normalize rule must be empty or one of ${NORMALIZE_RULES.join("|")}`,
    };
  }

  return {
    ok: true,
    value: {
      key,
      label: label === "" ? null : label,
      type,
      required: text(values, "required") !== "",
      enumValues,
      normalizeRule: normalizeRule === "" ? null : normalizeRule,
      sortOrder,
    },
  };
}

// --- Routing rules ---------------------------------------------------------

export interface RuleInput {
  label: string | null;
  condition: unknown;
  actionType: EditableActionType;
  targetQueue: string | null;
  priority: string | null;
  /** Evaluation order: rules are first-match-wins, lowest first. */
  sortOrder: number;
}

export function parseRule(values: FormValues): ParseResult<RuleInput> {
  const actionType = text(values, "action_type") as EditableActionType;
  if (!ACTION_TYPES.includes(actionType)) {
    return {
      ok: false,
      error: `action must be one of ${ACTION_TYPES.join("|")}`,
    };
  }

  const rawCondition = text(values, "condition") || '{"all":[]}';
  let condition: unknown;
  try {
    condition = JSON.parse(rawCondition);
  } catch {
    return { ok: false, error: "condition must be valid JSON" };
  }
  if (typeof condition !== "object" || condition === null) {
    return { ok: false, error: "condition must be a JSON object" };
  }

  const label = text(values, "label");
  const targetQueue = text(values, "target_queue");

  // Priority reaches a case's queue ordering, so a typo here would quietly
  // mis-sort real work — constrain it to the known set at the boundary.
  const priority = text(values, "priority");
  if (priority !== "" && !isPriority(priority)) {
    return {
      ok: false,
      error: `priority must be one of ${PRIORITIES.join("|")}`,
    };
  }

  if (
    (actionType === "route" || actionType === "escalate") &&
    targetQueue === ""
  ) {
    return { ok: false, error: `${actionType} needs a target queue` };
  }

  // Evaluation is first-match-wins, so this is the merchant's precedence.
  const sortOrder = int(values, "sort_order", 0);
  if (sortOrder === null) {
    return { ok: false, error: "sort_order must be a non-negative number" };
  }

  return {
    ok: true,
    value: {
      label: label === "" ? null : label,
      condition,
      actionType,
      targetQueue: targetQueue === "" ? null : targetQueue,
      priority: priority === "" ? null : priority,
      sortOrder,
    },
  };
}
