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
} from "./types";

function getCategory(
  config: IntakeConfig,
  key: string | undefined,
): CategoryDef {
  const cat = config.categories.find((c) => c.key === key);
  if (!cat) throw new Error(`unknown category: ${String(key)}`);
  return cat;
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

function assemble(config: IntakeConfig, state: IntakeState): IntakeCase {
  const cat = getCategory(config, state.categoryKey);
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

/** Decide what to ask next given the current (already-transitioned) state. */
function proceed(config: IntakeConfig, state: IntakeState): IntakeSession {
  if (state.status === "selecting_category") {
    return {
      state,
      prompt: {
        kind: "select_category",
        options: categoryOptions(config),
        retry: false,
      },
    };
  }

  if (state.status === "selecting_subcategory") {
    const cat = getCategory(config, state.categoryKey);
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

  // collecting_fields: fold any pre-extracted fields once, then find the gap.
  const cat = getCategory(config, state.categoryKey);
  let fields = state.fields;
  if (Object.keys(state.pendingInitial).length > 0) {
    fields = { ...fields };
    for (const fd of cat.fields) {
      const raw = state.pendingInitial[fd.key];
      if (raw !== undefined && !isCollected(fields, fd.key)) {
        const captured = normalizeField(fd, raw, config);
        if (captured.valid) fields[fd.key] = captured;
      }
    }
  }
  const folded: IntakeState = { ...state, fields, pendingInitial: {} };

  const next = cat.fields.find(
    (fd) => fd.required && !isCollected(folded.fields, fd.key),
  );
  if (next) {
    return {
      state: { ...folded, pendingFieldKey: next.key },
      prompt: { kind: "request_field", field: next, retry: false },
    };
  }

  const complete: IntakeState = {
    ...folded,
    status: "complete",
    pendingFieldKey: undefined,
  };
  return {
    state: complete,
    prompt: { kind: "complete", case: assemble(config, complete) },
  };
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
  return proceed(config, state);
}

/** Fold one inbound message into the session and return the next prompt. */
export function advance(
  config: IntakeConfig,
  state: IntakeState,
  message: string,
): IntakeSession {
  switch (state.status) {
    case "selecting_category": {
      const opt = matchOption(message, categoryOptions(config));
      if (!opt) {
        return {
          state,
          prompt: {
            kind: "select_category",
            options: categoryOptions(config),
            retry: true,
          },
        };
      }
      const cat = getCategory(config, opt.key);
      return proceed(config, {
        ...state,
        categoryKey: cat.key,
        status:
          cat.subcategories.length > 0
            ? "selecting_subcategory"
            : "collecting_fields",
      });
    }

    case "selecting_subcategory": {
      const cat = getCategory(config, state.categoryKey);
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

    case "collecting_fields": {
      const cat = getCategory(config, state.categoryKey);
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
          prompt: { kind: "request_field", field, retry: true },
        };
      }
      return proceed(config, next);
    }

    case "complete":
      return {
        state,
        prompt: { kind: "complete", case: assemble(config, state) },
      };
  }
}
