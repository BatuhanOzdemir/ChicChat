import type { SimulatorMessageInput } from "@/lib/simulator/protocol";
import type { SimulatorResponse } from "@/server/simulator/service";
import type { Preset } from "./presets";

interface PresetControls {
  reset: () => Promise<SimulatorResponse | null>;
  send: (message: SimulatorMessageInput) => Promise<SimulatorResponse | null>;
  stopped: () => boolean;
  notify: (message: string) => void;
}

/** Send each scripted answer once; a rejected answer hands control to the user. */
export async function playPreset(
  preset: Preset,
  controls: PresetControls,
): Promise<void> {
  const { send, stopped, notify } = controls;
  const reset = await controls.reset();
  if (!reset || reset.error || stopped()) return;
  const greeting: SimulatorMessageInput = {
    kind: "text",
    value: preset.greeting,
    ...(preset.replayGreeting
      ? { messageId: `wamid.sim.replay.${crypto.randomUUID()}` }
      : {}),
  };
  let last = await send(greeting);
  if (!last || last.error || stopped()) return;
  if (preset.replayGreeting) {
    await send(greeting);
    return;
  }
  const visited = new Set<string>();
  for (let step = 0; step < 30 && !stopped(); step++) {
    if (!last || last.error || last.completedCase || !last.session) return;
    const state = last.session;
    const key = `${state.status}:${state.pendingFieldKey ?? ""}`;
    if (visited.has(key)) {
      notify(
        "Preset paused: the answer was not accepted. Choose one of the displayed options or enter a valid answer to continue.",
      );
      return;
    }
    visited.add(key);
    const choice =
      state.status === "selecting_category"
        ? preset.category
        : state.status === "selecting_subcategory"
          ? preset.subcategory
          : undefined;
    const answer = choice
      ? { kind: "list" as const, value: choice }
      : state.pendingFieldKey
        ? preset.answers?.[state.pendingFieldKey]
        : undefined;
    if (!answer) {
      notify(
        "Preset paused: no scripted answer for this question. Choose an option or answer it yourself to continue.",
      );
      return;
    }
    last = await send(answer);
  }
  if (!stopped() && last?.session)
    notify(
      "Preset paused after 30 steps. Continue manually or reset the conversation.",
    );
}
