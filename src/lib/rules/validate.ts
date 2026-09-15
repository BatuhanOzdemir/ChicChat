import type { Condition } from "./types";

const OPS = new Set([
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
]);

/** Bound both depth and work; stored configuration is an untrusted boundary too. */
export function isCondition(value: unknown): value is Condition {
  let remaining = 256;
  function visit(node: unknown, depth: number): boolean {
    if (
      --remaining < 0 ||
      depth > 16 ||
      !node ||
      typeof node !== "object" ||
      Array.isArray(node)
    )
      return false;
    const obj = node as Record<string, unknown>;
    const groups = ["all", "any", "not"].filter((key) => key in obj);
    if (groups.length) {
      if (groups.length !== 1 || Object.keys(obj).length !== 1) return false;
      const key = groups[0];
      return key === "not"
        ? visit(obj.not, depth + 1)
        : Array.isArray(obj[key]) &&
            obj[key].every((child) => visit(child, depth + 1));
    }
    if (
      typeof obj.field !== "string" ||
      !obj.field.trim() ||
      typeof obj.op !== "string" ||
      !OPS.has(obj.op)
    )
      return false;
    if (
      Object.keys(obj).some(
        (key) => !["field", "op", "value", "ref"].includes(key),
      )
    )
      return false;
    if (obj.op === "present" || obj.op === "absent")
      return !("value" in obj) && !("ref" in obj);
    if ("ref" in obj)
      return (
        typeof obj.ref === "string" && !!obj.ref.trim() && !("value" in obj)
      );
    if (!("value" in obj)) return false;
    if (obj.op === "in" || obj.op === "nin")
      return Array.isArray(obj.value) && obj.value.length <= 100;
    return (
      obj.value === null ||
      ["string", "number", "boolean"].includes(typeof obj.value)
    );
  }
  return visit(value, 0);
}
