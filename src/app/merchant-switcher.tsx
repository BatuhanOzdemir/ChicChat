import type { MerchantContext } from "@/server/merchant/current";
import { selectMerchant } from "./merchant-actions";

/**
 * Which tenant am I looking at, and switch to another (Step 6). Shown on every
 * console surface, because "whose data is this?" must never be a guess.
 */
export function MerchantSwitcher({
  context,
  back,
}: {
  context: MerchantContext;
  /** Path to return to after switching. */
  back: string;
}) {
  const { current, options } = context;

  if (options.length === 1) {
    return (
      <span className="text-xs text-zinc-500">
        merchant <strong>{current.name}</strong>
      </span>
    );
  }

  return (
    <form
      action={selectMerchant}
      className="flex items-center gap-2 text-xs text-zinc-500"
    >
      <input type="hidden" name="back" value={back} />
      <label className="flex items-center gap-1">
        merchant
        <select
          className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900"
          name="merchant_id"
          defaultValue={current.id}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="rounded border border-zinc-300 px-2 py-1 font-medium hover:border-zinc-500 dark:border-zinc-700"
      >
        Switch
      </button>
    </form>
  );
}
