import { expect, it } from "vitest";
import { availableOptions } from "./available-options";
import type { TranscriptEntry } from "./types";

const question: TranscriptEntry = {
  id: "question",
  role: "bot",
  text: "Choose a reason",
  options: [{ id: "wrong_size", title: "Wrong size" }],
};
const nudge: TranscriptEntry = {
  id: "nudge",
  role: "bot",
  text: "Still there?",
  notification: true,
};
it("keeps the unanswered choices tappable after a nudge", () => {
  expect(availableOptions([question, nudge], true)).toEqual(question.options);
});
it("removes stale choices when the session ends or is abandoned", () => {
  expect(availableOptions([question, nudge], false)).toEqual([]);
});
it("replaces old choices when intake advances to a text question", () => {
  expect(
    availableOptions(
      [question, { id: "next", role: "bot", text: "Describe the item" }, nudge],
      true,
    ),
  ).toEqual([]);
});
