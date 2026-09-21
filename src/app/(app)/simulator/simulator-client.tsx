"use client";

import { useCallback, useRef, useState } from "react";
import type { HandoffPackage } from "@/db/cases";
import type { IntakeState } from "@/lib/intake";
import type { ListRow, OutboundMessage } from "@/lib/whatsapp";
import type {
  SimulatorErrorInjection,
  SimulatorMessageInput,
} from "@/lib/simulator/protocol";
import type { SimulatorResponse } from "@/server/simulator/service";
import { ChatPanel } from "./chat-panel";
import { ControlPanel } from "./control-panel";
import { InspectorPanel } from "./inspector-panel";
import type { Preset } from "./presets";
import { playPreset } from "./run-preset";
import type { MerchantOption, TranscriptEntry } from "./types";

const DEFAULT_PHONE = "905550000001";

function bubbleFor(message: OutboundMessage): TranscriptEntry {
  const id = `bot-${crypto.randomUUID()}`;
  if (message.type === "text") {
    return { id, role: "bot", text: message.text.body };
  }
  const { header, body, action } = message.interactive;
  const text = [header?.text, body.text].filter(Boolean).join("\n");
  return { id, role: "bot", text, options: action.sections[0]?.rows ?? [] };
}

export function SimulatorClient({
  merchants,
  selectedMerchantId,
}: {
  merchants: MerchantOption[];
  selectedMerchantId?: string;
}) {
  const [merchantId, setMerchantId] = useState(
    selectedMerchantId ?? merchants[0]?.id ?? "",
  );
  const [phone, setPhone] = useState(DEFAULT_PHONE);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [session, setSession] = useState<IntakeState | null>(null);
  const [sessionMeta, setSessionMeta] =
    useState<SimulatorResponse["sessionMeta"]>(null);
  const [completedCase, setCompletedCase] = useState<HandoffPackage | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [injectError, setInjectError] = useState<SimulatorErrorInjection | "">(
    "",
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const stopRef = useRef(false);
  const [presetRunning, setPresetRunning] = useState(false);
  const injectionRef = useRef<SimulatorErrorInjection | "">("");

  const rtl = merchants.find((m) => m.id === merchantId)?.rtl ?? false;

  const push = useCallback((entry: Omit<TranscriptEntry, "id">) => {
    setTranscript((prev) => [
      ...prev,
      { ...entry, id: `${entry.role}-${crypto.randomUUID()}` },
    ]);
  }, []);

  const call = useCallback(
    async (
      body: Record<string, unknown>,
    ): Promise<SimulatorResponse | null> => {
      const res = await fetch("/api/simulator", {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantId, phone, ...body }),
      });
      const data = (await res.json()) as SimulatorResponse & { error?: string };
      if (!res.ok) {
        setError(data.error ?? `request failed (${res.status})`);
        return null;
      }
      setSession(data.session);
      setSessionMeta(data.sessionMeta);
      setError(data.error);
      setNotice(data.notice);
      if (data.completedCase) setCompletedCase(data.completedCase);
      for (const message of data.outbound ?? [])
        push({
          ...bubbleFor(message),
          notification:
            body.action === "maintenance" || body.action === "time_travel",
        });
      if (data.error) push({ role: "system", text: `⚠ ${data.error}` });
      return data;
    },
    [merchantId, phone, push],
  );

  /**
   * Switching tenants starts a different conversation: the session, case and
   * chat log belong to the merchant they came from, so showing them under
   * another merchant's name would be a lie (Step 6). The DB-side session is
   * left alone — the point of the switcher is that both can be mid-intake.
   */
  const changeMerchant = useCallback(
    (next: string) => {
      setMerchantId(next);
      setTranscript([]);
      setCompletedCase(null);
      setError(null);
      // `call` still closes over the previous id, so the new one is passed
      // explicitly; this loads whatever session the new tenant already has for
      // this phone, which is how interleaved conversations stay visible.
      void call({ action: "state", merchantId: next });
    },
    [call],
  );

  const send = useCallback(
    async (
      message: SimulatorMessageInput,
      label?: string,
    ): Promise<SimulatorResponse | null> => {
      push({
        role: "customer",
        text: label ?? message.value,
        isPhoto: message.kind === "photo",
      });
      const injection = injectionRef.current;
      injectionRef.current = "";
      setInjectError("");
      return call({
        action: "message",
        message,
        ...(injection ? { injectError: injection } : {}),
      });
    },
    [call, push],
  );

  const guard = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } catch {
      setError(
        "The request could not finish. Refresh the session before retrying; it may already have been processed.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const runPreset = useCallback(
    async (preset: Preset) => {
      stopRef.current = false;
      setPresetRunning(true);
      setTranscript([]);
      setCompletedCase(null);
      try {
        await playPreset(preset, {
          reset: () => call({ action: "reset" }),
          send,
          stopped: () => stopRef.current,
          notify: (text) => push({ role: "system", text }),
        });
      } finally {
        setPresetRunning(false);
        if (stopRef.current)
          push({
            role: "system",
            text: "Preset stopped. The last request may have finished. Continue manually or reset the conversation.",
          });
      }
    },
    [call, push, send],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <ChatPanel
        active={session !== null}
        transcript={transcript}
        busy={busy}
        rtl={rtl}
        onSendText={(text) =>
          guard(async () => void (await send({ kind: "text", value: text })))
        }
        onTapOption={(row: ListRow) =>
          guard(
            async () =>
              void (await send({ kind: "list", value: row.id }, row.title)),
          )
        }
      />
      <div className="space-y-4">
        <ControlPanel
          merchants={merchants}
          merchantId={merchantId}
          phone={phone}
          busy={busy}
          presetRunning={presetRunning}
          onStopPreset={() => {
            stopRef.current = true;
            setNotice("Stopping after the current request finishes…");
          }}
          onRefresh={() =>
            void guard(async () => {
              await call({ action: "state" });
            })
          }
          injectError={injectError}
          onMerchantChange={changeMerchant}
          onPhoneChange={setPhone}
          onInjectChange={(value) => {
            injectionRef.current = value;
            setInjectError(value);
          }}
          onSendPhoto={() =>
            guard(
              async () =>
                void (await send(
                  { kind: "photo", value: `media.sim.${Date.now()}` },
                  "(photo)",
                )),
            )
          }
          onSendFlow={(responseJson) =>
            guard(
              async () =>
                void (await send(
                  { kind: "flow", value: responseJson },
                  "(Flow submitted)",
                )),
            )
          }
          onRunPreset={(preset) => guard(() => runPreset(preset))}
          onTimeTravel={(minutes) =>
            guard(async () => {
              await call({ action: "time_travel", ageMinutes: minutes });
            })
          }
          onRunMaintenance={() =>
            guard(async () => {
              await call({ action: "maintenance" });
            })
          }
          onRetryDelivery={() =>
            void guard(async () => {
              await call({ action: "retry_delivery" });
            })
          }
          onReset={() =>
            guard(async () => {
              setTranscript([]);
              setCompletedCase(null);
              setNotice(null);
              await call({ action: "reset" });
            })
          }
        />
        <InspectorPanel
          session={session}
          sessionMeta={sessionMeta}
          completedCase={completedCase}
          error={error}
          notice={notice}
        />
      </div>
    </div>
  );
}
