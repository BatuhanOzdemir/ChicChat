import { getDatabase } from "@/db/client";
import { DEMO_MERCHANT_ID, loadMerchantConfig } from "@/db/config";
import { listRules } from "@/db/taxonomy";
import { addCategory } from "./actions";
import { CategoryEditor, type RuleRow } from "./category-editor";
import { PolicyForm } from "./policy-form";
import { Card, ErrorBanner, Field, input, primaryButton } from "./ui";

// Reads the live DB on every request.
export const dynamic = "force-dynamic";

export default async function ConfigPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const db = getDatabase();
  const config = await loadMerchantConfig(db, DEMO_MERCHANT_ID);

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

  const rules = (await listRules(db, DEMO_MERCHANT_ID)) as RuleRow[];
  const { merchant, settings, categories } = config;
  const enabledCount = categories.filter((c) => c.enabled).length;

  return (
    <main
      dir={merchant.rtl ? "rtl" : "ltr"}
      className="mx-auto max-w-5xl p-6 text-zinc-900 dark:text-zinc-100"
    >
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">Merchant configuration</h1>
        <p className="text-sm text-zinc-500">
          {merchant.name} · locale <code>{merchant.locale}</code> ·{" "}
          {merchant.rtl ? "RTL" : "LTR"} · {enabledCount}/{categories.length}{" "}
          categories enabled ·{" "}
          <a className="underline" href="/simulator">
            test in the simulator →
          </a>
        </p>
      </header>

      <ErrorBanner message={error} />

      <div className="space-y-4">
        <PolicyForm settings={settings} />

        <section className="space-y-3">
          <h2 className="font-medium">Categories</h2>
          {categories.map((category) => (
            <CategoryEditor
              key={category.id}
              category={category}
              rules={rules.filter((r) => r.category_id === category.id)}
            />
          ))}
        </section>

        <Card title="Add a category" tone="muted">
          <form action={addCategory} className="flex flex-wrap items-end gap-3">
            <Field label="Label (any language)" width="w-64">
              <input className={input} name="label" required />
            </Field>
            <Field label="Key (optional — derived from the label)" width="w-56">
              <input className={input} name="key" placeholder="auto" />
            </Field>
            <Field label="Order" width="w-20">
              <input
                className={input}
                type="number"
                name="sort_order"
                defaultValue={(categories.length + 1) * 10}
              />
            </Field>
            <button type="submit" className={primaryButton}>
              Create category
            </button>
          </form>
        </Card>
      </div>
    </main>
  );
}
