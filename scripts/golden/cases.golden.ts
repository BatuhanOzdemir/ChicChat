import { it } from "vitest";
import {
  abandonmentRate,
  formatDuration,
  formatPercent,
  median,
} from "@/lib/cases/analytics";
import { formatDateTime } from "@/lib/cases/date";
import { parseCaseFilters } from "@/lib/cases/filters";
import {
  decideRouting,
  describeRouting,
  routingContext,
} from "@/lib/cases/routing";
import type { LabelledRule } from "@/lib/cases/routing";
import {
  ageLabel,
  constrainPriority,
  parseNote,
  planTransition,
  CASE_STATUSES,
} from "@/lib/cases/workflow";
import { EDGE_STRINGS, Recorder } from "./record";

it("records cases", () => {
  const r = new Recorder("cases");
  const statuses = [...CASE_STATUSES, "done", ""];
  for (const from of statuses)
    for (const to of statuses)
      r.call("planTransition", planTransition, from, to);
  for (const s of [...EDGE_STRINGS, "HIGH", " low ", "Normal", "urgent"])
    r.call("constrainPriority", constrainPriority, s);
  r.call("constrainPriority", constrainPriority, null);
  for (const s of [
    ...EDGE_STRINGS,
    "👗".repeat(1000),
    "👗".repeat(1001),
    "x".repeat(2000),
    "x".repeat(2001),
  ])
    r.call("parseNote", parseNote, s);
  const now = new Date("2026-07-29T12:00:00Z");
  for (const created of [
    "2026-07-29T11:59:30Z",
    "2026-07-29T11:59:00Z",
    "2026-07-29T11:20:00Z",
    "2026-07-29T02:00:00Z",
    "2026-07-27T12:00:01Z",
    "2026-07-27T12:00:00Z",
    "2026-07-25T12:00:00Z",
    "2026-07-30T12:00:00Z",
    "not a date",
    "2026-02-30",
  ])
    r.call("ageLabel", (c: string) => ageLabel(c, now), created);
  for (const values of [
    [],
    [1],
    [3, 1, 2],
    [10, 20, 30, 40],
    [1.5, 2.5],
    [-1, 5],
  ])
    r.call("median", median, values);
  for (const [a, b] of [
    [0, 0],
    [3, 1],
    [0, 2],
    [1, 2],
    [2, 1],
  ])
    r.call("abandonmentRate", abandonmentRate, a, b);
  for (const s of [
    null,
    0,
    0.4,
    0.5,
    1.5,
    2.5,
    -3,
    42,
    59.5,
    60,
    252,
    3599.5,
    3600,
    3900,
    86400,
    100000.5,
  ])
    r.call("formatDuration", formatDuration, s);
  for (const f of [null, 0, 0.125, 0.25, 0.285, 0.005, 0.015, 1, 1 / 3, 2 / 3])
    r.call("formatPercent", formatPercent, f);
  for (const v of [
    "2026-09-14T22:05:00Z",
    "2026-03-29T00:30:00Z",
    "2026-12-31T21:00:00Z",
    "2026-06-01T00:00:00Z",
    "invalid",
    "2026-09-14T22:05:00.999Z",
  ])
    r.call("formatDateTime", formatDateTime, v);
  const filterInputs: Record<string, string | string[]>[] = [
    {},
    { status: "open" },
    { status: "exploded" },
    { status: " closed " },
    { from: "2026-07-01" },
    { from: "01/07/2026" },
    { from: "2026-08-01", to: "2026-07-01" },
    { to: "2026-7-1" },
    { order_number: "  #tr-100 432 " },
    { order_number: "###" },
    { page: "0" },
    { page: "abc" },
    { page: "2" },
    { page: "1e1" },
    { page: "0x10" },
    { page: "2.0" },
    { page: "2.5" },
    { page: " 3 " },
    { page: ["4", "5"] },
    { status: ["open", "x"] },
    { category: " return " },
    { queue: "unrouted" },
    { from: "٢٠٢٦-٠٧-٠١" },
  ];
  for (const p of filterInputs) r.call("parseCaseFilters", parseCaseFilters, p);
  const rules: LabelledRule[] = [
    {
      id: "r1",
      label: "damaged with photo",
      condition: {
        all: [
          { field: "subcategory", op: "in", value: ["damaged", "defective"] },
          { field: "photo", op: "present" },
        ],
      },
      action_type: "route",
      target_queue: "priority_replacements",
      priority: "high",
    },
    {
      id: "r2",
      label: "  ",
      condition: { all: [{ field: "photo", op: "absent" }] },
      action_type: "request_info",
      target_queue: null,
      priority: "NORMAL",
    },
    {
      label: null,
      condition: {
        all: [{ field: "subcategory", op: "eq", value: "item_missing" }],
      },
      action_type: "escalate",
      target_queue: " verify ",
      priority: "URGENT!",
    },
    { condition: { all: [] }, action_type: "auto_reply" },
    { condition: { bogus: 1 }, action_type: "route", target_queue: "x" },
  ];
  for (const sub of ["damaged", "item_missing", "wrong_item"])
    for (const fields of [
      [],
      [{ key: "photo", raw: "m.1", normalized: "m.1" }],
      [{ key: "photo", raw: "m.1", normalized: null }],
    ]) {
      const ctx = routingContext({ category: "c", subcategory: sub, fields });
      r.call("routingContext", routingContext, {
        category: "c",
        subcategory: sub,
        fields,
      });
      for (const set of [rules, rules.slice(2), [], [rules[4]]]) {
        r.call("decideRouting", decideRouting, set, ctx);
        r.call("describeRouting", describeRouting, decideRouting(set, ctx));
      }
    }
  r.call("routingContext", routingContext, {
    category: "c",
    subcategory: null,
    fields: [],
    settings: { a: 1 },
  });
  r.write();
});
