import { it } from "vitest";
import {
  constrainEnum,
  normalizeOrderNumber,
  normalizeText,
} from "@/lib/normalize";
import { EDGE_STRINGS, Recorder } from "./record";

const PATTERNS = [
  "",
  "^[A-Z0-9]{4,}$",
  "^TR\\d{6}$",
  "\\d{3}",
  "^\\w+$",
  "^(?<prefix>[A-Z]{2})\\d+$",
  "^[A-Z]{2}[0-9]+",
  "[",
  "(",
  "^\\s*$",
  "^.{3,}$",
  "\\bTR",
  "tr\\d+",
];
const ALLOWED = [
  "damaged",
  "defective",
  "wrong_item",
  "Wrong_Size",
  "İade",
  "ılık",
];

it("records normalize", () => {
  const r = new Recorder("normalize");
  for (const s of EDGE_STRINGS) {
    r.call("normalizeText", normalizeText, s);
    r.call("normalizeOrderNumber", normalizeOrderNumber, s, {});
    r.call("normalizeOrderNumber", normalizeOrderNumber, s, {
      stripLeadingZeros: false,
    });
    for (const pattern of PATTERNS)
      r.call("normalizeOrderNumber", normalizeOrderNumber, s, { pattern });
    r.call("constrainEnum", constrainEnum, s, ALLOWED, {});
    r.call("constrainEnum", constrainEnum, s, ALLOWED, {
      caseInsensitive: false,
    });
  }
  for (const s of [
    " DAMAGED ",
    "iade",
    "İADE",
    "ILIK",
    "wrong_size",
    "WRONG_SIZE",
  ]) {
    r.call("constrainEnum", constrainEnum, s, ALLOWED, {});
  }
  r.write();
});
