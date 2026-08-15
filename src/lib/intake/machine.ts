/**
 * The taxonomy-driven intake state machine (CLAUDE.md Step 5).
 *
 * Pure and framework-free: `startIntake` returns the first prompt; `advance`
 * folds one inbound message into the state and returns the next prompt. It only
 * ever asks for *missing required* fields (§0.4), normalizes captured values via
 * the Step 3 layer, re-asks on invalid input, and assembles a clean Tier-0 case.
 */
import {
  constrainEnum,
  normalizeOrderNumber,
  normalizeText,
} from "../normalize";
import type {
  CapturedField,
  CategoryDef,
  FieldDef,
  IntakeCase,
  IntakeConfig,
  IntakeSession,
  IntakeState,
  Option,
  Prompt,
} from "./types";

/**
 * Look up a category. Returns undefined rather than throwing (Handbook §3): a
 * live session can outlive the category it selected — the merchant may disable
 * or rename it mid-conversation — and the machine recovers by asking again
 * instead of failing the conversation.
 */
function findCategory(
  config: IntakeConfig,
  key: string | undefined,
): CategoryDef | undefined {
  return config.categories.find((c) => c.key === key);
}

/** Turn an enum value into a readable option label ("store_credit" → "Store credit"). */
function optionForValue(value: string): Option {
  const words = value.replace(/[_-]+/g, " ").trim();
  return {
    key: value,
    label: words.charAt(0).toUpperCase() + words.slice(1),
  };
}

/**
 * Ask for a field. Enum fields with configured values are always offered as a
 * tappable list (SPEC §5) so the customer never has to guess a valid value.
 */
function fieldPrompt(field: FieldDef, retry: boolean): Prompt {
  if (
    field.type === "enum" &&
    field.enumValues &&
    field.enumValues.length > 0
  ) {
    return {
      kind: "select_field",
      field,
      options: field.enumValues.map(optionForValue),
      retry,
    };
  }
  return { kind: "request_field", field, retry };
}

/** A fresh category selection, used to start and to recover. */
function categoryPrompt(
  config: IntakeConfig,
  state: IntakeState,
  retry: boolean,
): IntakeSession {
  return {
    state: {
      ...state,
      status: "selecting_category",
      categoryKey: undefined,
      subcategoryKey: undefined,
      pendingFieldKey: undefined,
    },
    prompt: {
      kind: "select_category",
      options: categoryOptions(config),
      retry,
    },
  };
}

function categoryOptions(config: IntakeConfig): Option[] {
  return config.categories.map((c) => ({ key: c.key, label: c.label }));
}

function isCollected(
  fields: Record<string, CapturedField>,
  key: string,
): boolean {
  return fields[key]?.valid === true;
}

/** Match an inbound message to a list option by index, key, or label (lenient). */
function matchOption(message: string, options: Option[]): Option | undefined {
  const trimmed = message.trim();
  if (trimmed === "") return undefined;

  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    if (index >= 0 && index < options.length) return options[index];
  }

  const lower = trimmed.toLowerCase();
  return options.find((o) => {
    const key = o.key.toLowerCase();
    const label = o.label.toLowerCase();
    return key === lower || label === lower || label.includes(lower);
  });
}

/** Normalize a captured value per the field's rule/type (Step 3 layer). */
function normalizeField(
  field: FieldDef,
  message: string,
  config: IntakeConfig,
): CapturedField {
  if (field.normalizeRule === "order_number") {
    const r = normalizeOrderNumber(message, { pattern: config.orderIdRegex });
    return { raw: message, normalized: r.normalized, valid: r.valid };
  }

  if (
    field.type === "enum" &&
    field.enumValues &&
    field.enumValues.length > 0
  ) {
    const r = constrainEnum(message, field.enumValues);
    return { raw: message, normalized: r.normalized, valid: r.valid };
  }

  // ref (Tier-0 text, §6.4), media reference, free-text enum, and string.
  const text = normalizeText(message);
  return {
    raw: message,
    normalized: text === "" ? null : text,
    valid: text !== "",
  };
}

function assemble(cat: CategoryDef, state: IntakeState): IntakeCase {
  const fields = cat.fields
    .filter((fd) => isCollected(state.fields, fd.key))
    .map((fd) => ({
      key: fd.key,
      raw: state.fields[fd.key].raw,
      normalized: state.fields[fd.key].normalized,
    }));
  return {
    category: cat.key,
    subcategory: state.subcategoryKey ?? null,
    integration_tier: 0,
    fields,
  };
}

/** Fold classifier-extracted raw values into the captured set, once. */
function foldInitialFields(
  cat: CategoryDef,
  state: IntakeState,
  config: IntakeConfig,
): IntakeState {
  if (Object.keys(state.pendingInitial).length === 0) {
    return { ...state, pendingInitial: {} };
  }
  const fields = { ...state.fields };
  for (const fd of cat.fields) {
    const raw = state.pendingInitial[fd.key];
    if (raw !== undefined && !isCollected(fields, fd.key)) {
      const captured = normalizeField(fd, raw, config);
      if (captured.valid) fields[fd.key] = captured;
    }
  }
  return { ...state, fields, pendingInitial: {} };
}

/** Ask for the next missing required field, or complete the case. */
function collectFields(
  config: IntakeConfig,
  cat: CategoryDef,
  state: IntakeState,
): IntakeSession {
  const folded = foldInitialFields(cat, state, config);

  const next = cat.fields.find(
    (fd) => fd.required && !isCollected(folded.fields, fd.key),
  );
  if (next) {
    return {
      state: { ...folded, pendingFieldKey: next.key },
      prompt: fieldPrompt(next, false),
    };
  }

  const complete: IntakeState = {
    ...folded,
    status: "complete",
    pendingFieldKey: undefined,
  };
  return {
    state: complete,
    prompt: { kind: "complete", case: assemble(cat, complete) },
  };
}

/** Decide what to ask next given the current (already-transitioned) state. */
function proceed(config: IntakeConfig, state: IntakeState): IntakeSession {
  if (state.status === "selecting_category") {
    return categoryPrompt(config, state, false);
  }

  const cat = findCategory(config, state.categoryKey);
  // The selected category disappeared (disabled/renamed) — recover, don't fail.
  if (!cat) return categoryPrompt(config, state, true);

  if (state.status === "selecting_subcategory") {
    return {
      state,
      prompt: {
        kind: "select_subcategory",
        category: cat.key,
        options: cat.subcategories,
        retry: false,
      },
    };
  }

  return collectFields(config, cat, state);
}

/** Begin an intake session. `initialFields` are raw values a classifier already extracted. */
export function startIntake(
  config: IntakeConfig,
  initialFields: Record<string, string> = {},
): IntakeSession {
  const state: IntakeState = {
    status: "selecting_category",
    fields: {},
    pendingInitial: { ...initialFields },
  };
  const session = proceed(config, state);

  // The KVKK disclosure belongs to the first message of a *new conversation*
  // (SPEC §12), which is precisely here and nowhere else. `categoryPrompt` is
  // also how the machine recovers mid-conversation — after unrecognized input,
  // or when the merchant disables the category a live session had chosen — and
  // repeating the notice on every stumble would train customers to ignore it.
  if (session.prompt.kind === "select_category" && config.kvkkUrl) {
    return {
      ...session,
      prompt: { ...session.prompt, disclosure: config.kvkkUrl },
    };
  }
  return session;
}

function pickCategory(
  config: IntakeConfig,
  state: IntakeState,
  message: string,
): IntakeSession {
  const opt = matchOption(message, categoryOptions(config));
  if (!opt) return categoryPrompt(config, state, true);

  const cat = findCategory(config, opt.key);
  if (!cat) return categoryPrompt(config, state, true);

  return proceed(config, {
    ...state,
    categoryKey: cat.key,
    status:
      cat.subcategories.length > 0
        ? "selecting_subcategory"
        : "collecting_fields",
  });
}

function pickSubcategory(
  config: IntakeConfig,
  cat: CategoryDef,
  state: IntakeState,
  message: string,
): IntakeSession {
  const opt = matchOption(message, cat.subcategories);
  if (!opt) {
    return {
      state,
      prompt: {
        kind: "select_subcategory",
        category: cat.key,
        options: cat.subcategories,
        retry: true,
      },
    };
  }
  return proceed(config, {
    ...state,
    subcategoryKey: opt.key,
    status: "collecting_fields",
  });
}

function captureField(
  config: IntakeConfig,
  cat: CategoryDef,
  state: IntakeState,
  message: string,
): IntakeSession {
  const field = cat.fields.find((f) => f.key === state.pendingFieldKey);
  if (!field) return proceed(config, state);

  const captured = normalizeField(field, message, config);
  const next: IntakeState = {
    ...state,
    fields: { ...state.fields, [field.key]: captured },
  };
  if (!captured.valid) {
    return {
      state: next,
      prompt: fieldPrompt(field, true),
    };
  }
  return proceed(config, next);
}

/** Fold one inbound message into the session and return the next prompt. */
export function advance(
  config: IntakeConfig,
  state: IntakeState,
  message: string,
): IntakeSession {
  if (state.status === "selecting_category") {
    return pickCategory(config, state, message);
  }

  const cat = findCategory(config, state.categoryKey);
  // The selected category disappeared mid-conversation — ask again.
  if (!cat) return categoryPrompt(config, state, true);

  switch (state.status) {
    case "selecting_subcategory":
      return pickSubcategory(config, cat, state, message);
    case "collecting_fields":
      return captureField(config, cat, state, message);
    case "complete":
      return {
        state,
        prompt: { kind: "complete", case: assemble(cat, state) },
      };
  }
}
