import { getPool } from "@/db/client";
import {
  DEMO_MERCHANT_ID,
  buildIntakeConfig,
  loadMerchantConfig,
} from "@/db/config";
import { saveConfig } from "./actions";

// Reads the live DB on every request.
export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  const pool = getPool();
  const config = await loadMerchantConfig(pool, DEMO_MERCHANT_ID);

  if (!config) {
    return (
      <main className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">Merchant configuration</h1>
        <p className="mt-4 text-red-600">
          Demo merchant not found. Run <code>npm run db:seed</code> first.
        </p>
      </main>
    );
  }

  // Intake preview: what the machine will ask for, given the current config.
  const intake = await buildIntakeConfig(pool, DEMO_MERCHANT_ID);
  const { merchant, settings, categories } = config;

  return (
    <main
      dir={merchant.rtl ? "rtl" : "ltr"}
      className="mx-auto max-w-3xl p-8 text-zinc-900 dark:text-zinc-100"
    >
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Merchant configuration</h1>
        <p className="text-sm text-zinc-500">
          {merchant.name} · locale <code>{merchant.locale}</code> ·{" "}
          {merchant.rtl ? "RTL" : "LTR"} · {merchant.currency}
        </p>
      </header>

      <form action={saveConfig} className="space-y-8">
        <section className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="mb-3 font-medium">Policy</h2>
          <div className="flex flex-wrap gap-6">
            <label className="flex flex-col gap-1 text-sm">
              Return window (days)
              <input
                type="number"
                min={0}
                name="settings.return_window_days"
                defaultValue={settings.return_window_days}
                className="w-32 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Refund SLA (days)
              <input
                type="number"
                min={0}
                name="settings.refund_sla_days"
                defaultValue={settings.refund_sla_days}
                className="w-32 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
              />
            </label>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-medium">Categories &amp; fields</h2>
          {categories.map((category) => (
            <fieldset
              key={category.id}
              className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
            >
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  name={`category.${category.id}.enabled`}
                  defaultChecked={category.enabled}
                  aria-label={`Enable ${category.key}`}
                />
                <input
                  type="text"
                  name={`category.${category.id}.label`}
                  defaultValue={category.label}
                  className="flex-1 rounded border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-900"
                />
                <code className="text-xs text-zinc-500">{category.key}</code>
              </div>

              {category.fields.length > 0 && (
                <ul className="mt-3 space-y-1 ps-7 text-sm">
                  {category.fields.map((field) => (
                    <li key={field.id} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        name={`field.${field.id}.required`}
                        defaultChecked={field.required}
                        aria-label={`Require ${field.key}`}
                      />
                      <span>{field.key}</span>
                      <span className="text-xs text-zinc-500">
                        ({field.type}) — required
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          ))}
        </section>

        <button
          type="submit"
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Save changes
        </button>
      </form>

      <section className="mt-10 rounded-lg border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
        <h2 className="mb-2 font-medium">Intake preview</h2>
        <p className="mb-3 text-sm text-zinc-500">
          What the WhatsApp intake will ask for, given the config above. Disable
          a category or clear a field&apos;s required box, save, and watch this
          change.
        </p>
        {intake.categories.length === 0 ? (
          <p className="text-sm text-zinc-500">No categories enabled.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {intake.categories.map((category) => {
              const required = category.fields
                .filter((f) => f.required)
                .map((f) => f.key);
              return (
                <li key={category.key}>
                  <span className="font-medium">{category.label}</span>{" "}
                  <span className="text-zinc-500">asks:</span>{" "}
                  {required.length > 0
                    ? required.join(", ")
                    : "(no required fields)"}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
