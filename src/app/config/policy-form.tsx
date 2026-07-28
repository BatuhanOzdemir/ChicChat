import type { MerchantSettings } from "@/db/config";
import { savePolicy } from "./actions";
import { Card, Field, input, primaryButton } from "./ui";

/** Policy settings, including the inactivity and KVKK values (SPEC §§8, 11, 12). */
export function PolicyForm({ settings }: { settings: MerchantSettings }) {
  return (
    <Card title="Policy">
      <form action={savePolicy} className="space-y-3">
        <div className="flex flex-wrap gap-4">
          <Field label="Return window (days)" width="w-40">
            <input
              className={input}
              type="number"
              min={0}
              name="return_window_days"
              defaultValue={settings.return_window_days}
            />
          </Field>
          <Field label="Refund SLA (days)" width="w-40">
            <input
              className={input}
              type="number"
              min={0}
              name="refund_sla_days"
              defaultValue={settings.refund_sla_days}
            />
          </Field>
          <Field label="Nudge after (minutes)" width="w-40">
            <input
              className={input}
              type="number"
              min={1}
              name="nudge_after_minutes"
              defaultValue={settings.nudge_after_minutes}
            />
          </Field>
          <Field label="Abandon after (hours)" width="w-40">
            <input
              className={input}
              type="number"
              min={1}
              name="abandon_after_hours"
              defaultValue={settings.abandon_after_hours}
            />
          </Field>
          <Field label="Retention (months)" width="w-40">
            <input
              className={input}
              type="number"
              min={0}
              name="retention_months"
              defaultValue={settings.retention_months}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-4">
          <Field label="KVKK aydınlatma metni URL" width="w-96">
            <input
              className={input}
              name="kvkk_url"
              placeholder="https://…"
              defaultValue={settings.kvkk_url ?? ""}
            />
          </Field>
          <Field label="Order-id pattern (regex)" width="w-64">
            <input
              className={input}
              name="order_id_regex"
              defaultValue={settings.order_id_regex ?? ""}
            />
          </Field>
        </div>
        <button type="submit" className={primaryButton}>
          Save policy
        </button>
      </form>
    </Card>
  );
}
