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
}: {
  merchants: MerchantOption[];
}) {
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? "");
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
      for (const message of data.outbound ?? []) push(bubbleFor(message));
      if (data.error) push({ role: "system", text: `⚠ ${data.error}` });
      return data;
    },
    [merchantId, phone, push],
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
      return call({
        action: "message",
        message,
        ...(injectError ? { injectError } : {}),
      });
    },
    [call, injectError, push],
  );

  const guard = useCallback(async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const runPreset = useCallback(
    async (preset: Preset) => {
      setTranscript([]);
      setCompletedCase(null);
      await call({ action: "reset" });

      const replayId = `wamid.sim.replay.${Date.now()}`;
      const greeting: SimulatorMessageInput = {
        kind: "text",
        value: preset.greeting,
        ...(preset.replayGreeting ? { messageId: replayId } : {}),
      };
      let last = await send(greeting);
      if (preset.replayGreeting) {
        push({ role: "system", text: "↻ replaying the same message id…" });
        last = await send(greeting, `${preset.greeting} (replay)`);
      }
      if (preset.category)
        last = await send({ kind: "list", value: preset.category });
      if (preset.subcategory)
        last = await send({ kind: "list", value: preset.subcategory });

      for (let i = 0; i < 12; i++) {
        const pending = last?.session?.pendingFieldKey;
        if (!pending) break;
        const answer = preset.answers?.[pending];
        if (!answer) {
          push({
            role: "system",
            text: `preset has no answer for "${pending}" — stopping`,
          });
          break;
        }
        last = await send(answer);
      }
    },
    [call, push, send],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <ChatPanel
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
          injectError={injectError}
          onMerchantChange={setMerchantId}
          onPhoneChange={setPhone}
          onInjectChange={setInjectError}
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
