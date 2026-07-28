"use client";

import type { SimulatorErrorInjection } from "@/lib/simulator/protocol";
import { PRESETS, type Preset } from "./presets";
import type { MerchantOption } from "./types";

interface ControlPanelProps {
  merchants: MerchantOption[];
  merchantId: string;
  phone: string;
  busy: boolean;
  injectError: SimulatorErrorInjection | "";
  onMerchantChange: (id: string) => void;
  onPhoneChange: (phone: string) => void;
  onInjectChange: (value: SimulatorErrorInjection | "") => void;
  onSendPhoto: () => void;
  onSendFlow: (responseJson: string) => void;
  onRunPreset: (preset: Preset) => void;
  onTimeTravel: (minutes: number) => void;
  onRunMaintenance: () => void;
  onReset: () => void;
}

const FLOW_SAMPLE = '{"item_ref":"Slim Fit Shirt — Blue / M"}';

export function ControlPanel({
  merchants,
  merchantId,
  phone,
  busy,
  injectError,
  onMerchantChange,
  onPhoneChange,
  onInjectChange,
  onSendPhoto,
  onSendFlow,
  onRunPreset,
  onTimeTravel,
  onRunMaintenance,
  onReset,
}: ControlPanelProps) {
  const field =
    "w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-800";
  const button =
    "rounded border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800";

  return (
    <section className="space-y-4 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="space-y-2">
        <h2 className="font-medium">Who</h2>
        <label className="block text-xs text-zinc-500">
          Merchant
          <select
            value={merchantId}
            onChange={(e) => onMerchantChange(e.target.value)}
            className={field}
          >
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.locale}
                {m.rtl ? ", RTL" : ""})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-zinc-500">
          Customer phone (fake)
          <input
            value={phone}
            onChange={(e) => onPhoneChange(e.target.value)}
            className={field}
          />
        </label>
      </div>

      <div className="space-y-2">
        <h2 className="font-medium">Send</h2>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={onSendPhoto}
          >
            🖼️ Fake photo
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() => onSendFlow(FLOW_SAMPLE)}
            title={FLOW_SAMPLE}
          >
            🧾 Fake Flow payload
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="font-medium">Presets</h2>
        <ul className="space-y-1">
          {PRESETS.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className={`${button} w-full text-left`}
                disabled={busy}
                onClick={() => onRunPreset(preset)}
                title={preset.description}
              >
                ▶ {preset.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h2 className="font-medium">Injection &amp; time</h2>
        <label className="block text-xs text-zinc-500">
          Error injection (applies to the next message)
          <select
            value={injectError}
            onChange={(e) =>
              onInjectChange(e.target.value as SimulatorErrorInjection | "")
            }
            className={field}
          >
            <option value="">none</option>
            <option value="handler_exception">handler_exception</option>
            <option value="integration_down">integration_down</option>
          </select>
        </label>
        <div className="flex flex-wrap gap-2">
          {[5, 60, 1440].map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={button}
              disabled={busy}
              onClick={() => onTimeTravel(minutes)}
            >
              ⏩ age {minutes < 60 ? `${minutes}m` : `${minutes / 60}h`}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={`${button} w-full`}
          disabled={busy}
          onClick={onRunMaintenance}
          title="Runs the inactivity job: nudge after nudge_after_minutes, abandon after abandon_after_hours"
        >
          🧹 Run maintenance now
        </button>
      </div>

      <button
        type="button"
        onClick={onReset}
        disabled={busy}
        className="w-full rounded bg-zinc-900 px-3 py-2 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
      >
        Reset session &amp; transcript
      </button>
    </section>
  );
}
