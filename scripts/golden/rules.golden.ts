import { it } from "vitest";
import { evaluateCondition, isWithinReturnWindow } from "@/lib/rules";
import { isCondition } from "@/lib/rules/validate";
import type { Condition } from "@/lib/rules";
import { Recorder } from "./record";

const VALUES: unknown[] = [
  null,
  true,
  false,
  0,
  1,
  2.5,
  -1,
  "",
  "0",
  "1",
  " 12 ",
  "1e3",
  "0x10",
  "Infinity",
  "-Infinity",
  "NaN",
  "nan",
  "12abc",
  "abc",
  "damaged",
  "Damaged",
  [],
  ["damaged"],
  {},
];
const OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "present",
  "absent",
];

it("records rules", () => {
  const r = new Recorder("rules");
  // Every value is copied: real input is parsed JSON, which never shares
  // objects, and `===` would otherwise treat a reused `{}` as equal.
  const fieldsets: Record<string, unknown>[] = [
    {},
    ...VALUES.map((v) => ({ x: structuredClone(v) })),
  ];
  for (const op of OPS) {
    for (const value of VALUES) {
      const cmp =
        op === "present" || op === "absent"
          ? { field: "x", op }
          : op === "in" || op === "nin"
            ? {
                field: "x",
                op,
                value: Array.isArray(value) ? value : [value, "damaged", 1],
              }
            : { field: "x", op, value };
      for (const fields of fieldsets) {
        r.call("evaluateCondition", evaluateCondition, cmp as Condition, {
          fields,
        });
      }
    }
    for (const fields of fieldsets)
      for (const config of [
        undefined,
        {},
        { sla: 14 },
        { sla: "14" },
        { sla: null },
      ])
        r.call(
          "evaluateCondition",
          evaluateCondition,
          { field: "x", op, ref: "sla" } as unknown as Condition,
          config === undefined ? { fields } : { fields, config },
        );
  }
  const trees: unknown[] = [
    null,
    [],
    {},
    { all: [] },
    { any: [] },
    { not: { all: [] } },
    { all: "invalid" },
    { not: null },
    { all: [], any: [] },
    { field: "x", op: "wat", value: 1 },
    { field: " ", op: "eq", value: 1 },
    { field: "x", op: "eq" },
    { field: "x", op: "eq", value: 1, extra: 1 },
    { field: "x", op: "present", value: 1 },
    { field: "x", op: "eq", ref: " " },
    { field: "x", op: "eq", ref: "a", value: 1 },
    { field: "x", op: "in", value: Array.from({ length: 101 }, (_, i) => i) },
    { field: "x", op: "in", value: Array.from({ length: 100 }, (_, i) => i) },
    { field: "x", op: "eq", value: { a: 1 } },
    { field: "x", op: "eq", value: [1] },
    {
      any: [
        { field: "x", op: "eq", value: 1 },
        { field: "y", op: "absent" },
      ],
    },
  ];
  let deep: unknown = { field: "x", op: "present" };
  for (let n = 0; n < 20; n++) {
    trees.push(deep);
    deep = { not: deep };
  }
  trees.push({
    all: Array.from({ length: 300 }, () => ({ field: "x", op: "present" })),
  });
  trees.push({
    all: Array.from({ length: 255 }, () => ({ field: "x", op: "present" })),
  });
  for (const tree of trees) {
    r.call("isCondition", isCondition, tree);
    for (const fields of [{}, { x: 1 }, { y: "a" }])
      r.call("evaluateCondition", evaluateCondition, tree as Condition, {
        fields,
      });
  }
  const now = new Date("2026-06-22T12:00:00Z");
  for (const date of [
    "2026-06-12T12:00:00Z",
    "2026-05-13T12:00:00Z",
    "2026-05-23T12:00:00Z",
    "2026-05-23T12:00:01Z",
    "not-a-date",
    "2026-05-23",
    "2026-02-30",
    "",
  ]) {
    for (const days of [0, 1, 30, 31])
      r.call("isWithinReturnWindow", isWithinReturnWindow, date, days, now);
  }
  r.write();
});
