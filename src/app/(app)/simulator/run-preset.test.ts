import { expect, it, vi } from "vitest";
import type { SimulatorResponse } from "@/server/simulator/service";
import { PRESETS } from "./presets";
import { playPreset } from "./run-preset";

const empty: SimulatorResponse = {
  outbound: [],
  session: null,
  sessionMeta: null,
  completedCase: null,
  error: null,
  notice: null,
};
const question: SimulatorResponse = {
  ...empty,
  session: {
    status: "collecting_fields",
    categoryKey: "return",
    pendingFieldKey: "reason",
    fields: {},
    pendingInitial: {},
  },
};

it("sends a rejected answer only once, then invites manual selection", async () => {
  const send = vi.fn().mockResolvedValue(question);
  const notify = vi.fn();
  await playPreset(PRESETS[0], {
    reset: async () => empty,
    send,
    stopped: () => false,
    notify,
  });
  expect(send).toHaveBeenCalledTimes(2); // greeting, then a single answer
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("Choose one of the displayed options"),
  );
});

it("stops after the in-flight request and sends no further answers", async () => {
  let stopped = false;
  const send = vi.fn(async () => {
    stopped = true;
    return question;
  });
  await playPreset(PRESETS[0], {
    reset: async () => empty,
    send,
    stopped: () => stopped,
    notify: vi.fn(),
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("does not send a greeting when reset is refused", async () => {
  const send = vi.fn();
  await playPreset(PRESETS[0], {
    reset: async () => ({ ...empty, error: "real WhatsApp activity" }),
    send,
    stopped: () => false,
    notify: vi.fn(),
  });
  expect(send).not.toHaveBeenCalled();
});

it("stops on a processing failure instead of replaying the rejected message", async () => {
  const send = vi
    .fn()
    .mockResolvedValue({ ...question, error: "delivery pending" });
  await playPreset(PRESETS[0], {
    reset: async () => empty,
    send,
    stopped: () => false,
    notify: vi.fn(),
  });
  expect(send).toHaveBeenCalledTimes(1);
});
