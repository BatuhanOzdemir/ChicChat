import { ConfigForm } from "./config-form";
import type { EditableCategory } from "@/db/config";
import {
  addField,
  addRule,
  addSubcategory,
  removeCategory,
  removeField,
  removeRule,
  removeSubcategory,
  saveCategory,
  saveField,
} from "./actions";
import {
  ACTION_TYPES,
  FIELD_TYPES,
  NORMALIZE_RULES,
  PRIORITIES,
} from "@/lib/config/forms";
import { dangerButton, Field, input, smallButton } from "./ui";

const FIELD_LABELS: Record<string, string> = {
  string: "Free text",
  enum: "Pick from a list",
  media: "Photo",
  ref: "Item description / reference",
};

export interface RuleRow {
  id: string;
  category_id: string;
  label: string | null;
  condition: unknown;
  action_type: string;
  target_queue: string | null;
  priority: string | null;
  sort_order: number;
}

/** One category: rename/reorder/disable/delete, plus its subcategories, fields and rules. */
export function CategoryEditor({
  category,
  rules,
}: {
  category: EditableCategory;
  rules: RuleRow[];
}) {
  return (
    <details
      className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      open={!category.enabled ? false : undefined}
    >
      <summary className="cursor-pointer text-sm font-medium">
        {category.label}{" "}
        <code className="text-xs font-normal text-zinc-500">
          {category.key}
        </code>
        {!category.enabled && (
          <span className="ms-2 rounded bg-zinc-200 px-1.5 py-0.5 text-xs font-normal text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
            disabled
          </span>
        )}
        <span className="ms-2 text-xs font-normal text-zinc-500">
          {category.subcategories.length} sub · {category.fields.length} fields
          · {rules.length} rules
        </span>
      </summary>

      <div className="mt-4 space-y-5">
        {/* Category itself */}
        <ConfigForm
          action={saveCategory}
          className="flex flex-wrap items-end gap-3"
        >
          <input type="hidden" name="id" value={category.id} />
          <input type="hidden" name="key" value={category.key} />
          <Field label="Label" width="w-64">
            <input
              className={input}
              name="label"
              defaultValue={category.label}
            />
          </Field>
          <Field label="Order" width="w-20">
            <input
              className={input}
              type="number"
              name="sort_order"
              defaultValue={category.sortOrder}
            />
          </Field>
          <label className="flex items-center gap-2 pb-1.5 text-xs">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={category.enabled}
            />
            Enabled
          </label>
          <button type="submit" className={smallButton}>
            Save
          </button>
        </ConfigForm>

        {/* Subcategories */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">
            Subcategories
          </h3>
          <ul className="mb-2 space-y-1">
            {category.subcategories.map((sub) => (
              <li key={sub.key} className="flex items-center gap-2 text-sm">
                <span>{sub.label}</span>
                <code className="text-xs text-zinc-500">{sub.key}</code>
                <ConfigForm action={removeSubcategory} className="ms-auto">
                  <input type="hidden" name="id" value={sub.id} />
                  <button type="submit" className={dangerButton}>
                    Delete
                  </button>
                </ConfigForm>
              </li>
            ))}
          </ul>
          <ConfigForm
            resetOnSuccess
            action={addSubcategory}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="category_id" value={category.id} />
            <Field label="New subcategory label" width="w-56">
              <input className={input} name="label" required />
            </Field>
            <Field label="Order" width="w-20">
              <input
                className={input}
                type="number"
                name="sort_order"
                defaultValue={0}
              />
            </Field>
            <button type="submit" className={smallButton}>
              Add
            </button>
          </ConfigForm>
        </div>

        {/* Fields */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">
            Fields (asked in this order)
          </h3>
          <p className="mb-3 text-xs text-zinc-500">
            Free text lets customers write their answer. Pick from a list gives
            them up to 10 choices to tap: enter one per line, for example Wrong
            size, Poor quality, Other. Photo asks for an image; Item description
            / reference asks which item they mean.
          </p>
          <ul className="mb-2 space-y-2">
            {category.fields.map((field) => (
              <li key={field.id}>
                <ConfigForm
                  action={saveField}
                  className="flex flex-wrap items-end gap-2 rounded border border-zinc-100 p-2 dark:border-zinc-800"
                >
                  <input type="hidden" name="id" value={field.id} />
                  <input type="hidden" name="key" value={field.key} />
                  <Field label="Question label" width="w-48">
                    <input
                      className={input}
                      name="label"
                      defaultValue={field.label ?? field.key}
                    />
                  </Field>
                  <Field label="Type" width="w-52">
                    <select
                      className={input}
                      name="type"
                      defaultValue={field.type}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {FIELD_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Choices (for Pick from a list)" width="w-56">
                    <textarea
                      className={input}
                      name="enum_values"
                      placeholder={"Wrong size\nPoor quality\nOther"}
                      rows={2}
                      defaultValue={(field.enumValues ?? []).join("\n")}
                    />
                  </Field>
                  <Field label="Normalize" width="w-36">
                    <select
                      className={input}
                      name="normalize_rule"
                      defaultValue={field.normalizeRule ?? ""}
                    >
                      <option value="">none</option>
                      {NORMALIZE_RULES.map((rule) => (
                        <option key={rule} value={rule}>
                          {rule}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Order" width="w-20">
                    <input
                      className={input}
                      type="number"
                      name="sort_order"
                      defaultValue={field.sortOrder}
                    />
                  </Field>
                  <label className="flex items-center gap-1 pb-1.5 text-xs">
                    <input
                      type="checkbox"
                      name="required"
                      defaultChecked={field.required}
                    />
                    Required
                  </label>
                  <button type="submit" className={smallButton}>
                    Save
                  </button>
                </ConfigForm>
                <ConfigForm action={removeField} className="mt-1">
                  <input type="hidden" name="id" value={field.id} />
                  <button type="submit" className={dangerButton}>
                    Delete {field.key}
                  </button>
                </ConfigForm>
              </li>
            ))}
          </ul>
          <ConfigForm
            resetOnSuccess
            action={addField}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="category_id" value={category.id} />
            <Field label="New field label" width="w-44">
              <input className={input} name="label" required />
            </Field>
            <Field label="Type" width="w-52">
              <select className={input} name="type" defaultValue="string">
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_LABELS[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Choices (for Pick from a list)" width="w-56">
              <textarea
                className={input}
                name="enum_values"
                placeholder={"Wrong size\nPoor quality\nOther"}
                rows={2}
              />
            </Field>
            <Field label="Normalize" width="w-36">
              <select className={input} name="normalize_rule" defaultValue="">
                <option value="">none</option>
                {NORMALIZE_RULES.map((rule) => (
                  <option key={rule} value={rule}>
                    {rule}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Order" width="w-20">
              <input
                className={input}
                type="number"
                name="sort_order"
                defaultValue={90}
              />
            </Field>
            <label className="flex items-center gap-1 pb-1.5 text-xs">
              <input type="checkbox" name="required" defaultChecked />
              Required
            </label>
            <button type="submit" className={smallButton}>
              Add field
            </button>
          </ConfigForm>
        </div>

        {/* Routing rules */}
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">
            Routing rules{" "}
            <span className="font-normal normal-case">
              — evaluated top to bottom, first match wins
            </span>
          </h3>
          <ul className="mb-2 space-y-1 text-sm">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-start gap-2">
                <span className="w-6 shrink-0 text-xs text-zinc-500">
                  #{rule.sort_order}
                </span>
                <div className="min-w-0">
                  <div>
                    {rule.label ?? rule.action_type}{" "}
                    <span className="text-xs text-zinc-500">
                      → {rule.action_type}
                      {rule.target_queue ? ` : ${rule.target_queue}` : ""}
                      {rule.priority ? ` (${rule.priority})` : ""}
                    </span>
                  </div>
                  <code className="block truncate text-xs text-zinc-500">
                    {JSON.stringify(rule.condition)}
                  </code>
                </div>
                <ConfigForm action={removeRule} className="ms-auto">
                  <input type="hidden" name="id" value={rule.id} />
                  <button type="submit" className={dangerButton}>
                    Delete
                  </button>
                </ConfigForm>
              </li>
            ))}
          </ul>
          <ConfigForm
            resetOnSuccess
            action={addRule}
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="category_id" value={category.id} />
            <Field label="Rule name" width="w-40">
              <input className={input} name="label" />
            </Field>
            <Field label="Order" width="w-16">
              <input
                className={input}
                name="sort_order"
                type="number"
                min={0}
                defaultValue={rules.length + 1}
              />
            </Field>
            <Field label="Match field (optional)" width="w-48">
              <input
                className={input}
                name="condition_field"
                placeholder="reason"
              />
            </Field>
            <Field label="Comparison" width="w-40">
              <select className={input} name="condition_op">
                <option value="eq">equals</option>
                <option value="neq">does not equal</option>
                <option value="gt">greater than</option>
                <option value="lt">less than</option>
                <option value="present">is present</option>
                <option value="absent">is missing</option>
              </select>
            </Field>
            <Field label="Match value" width="w-48">
              <input
                className={input}
                name="condition_value"
                placeholder="wrong_size"
              />
            </Field>
            <Field
              label="Advanced condition (JSON; used when Match field is empty)"
              width="w-72"
            >
              <textarea
                className={input}
                name="condition"
                rows={2}
                placeholder='{"all":[{"field":"subcategory","op":"eq","value":"damaged"}]}'
              />
            </Field>
            <Field label="Action" width="w-32">
              <select className={input} name="action_type" defaultValue="route">
                {ACTION_TYPES.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Queue" width="w-40">
              <input className={input} name="target_queue" />
            </Field>
            <Field label="Priority" width="w-24">
              {/* A dropdown, because priority drives the console's queue order
                  and a typo would sort real work wrongly. */}
              <select className={input} name="priority" defaultValue="normal">
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" className={smallButton}>
              Add rule
            </button>
          </ConfigForm>
        </div>

        <ConfigForm
          action={removeCategory}
          className="border-t pt-3 dark:border-zinc-800"
        >
          <input type="hidden" name="id" value={category.id} />
          <button type="submit" className={dangerButton}>
            Delete category “{category.label}”
          </button>
        </ConfigForm>
      </div>
    </details>
  );
}
