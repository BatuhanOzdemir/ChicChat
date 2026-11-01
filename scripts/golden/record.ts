/** Shared recorder for golden files (docs/PORT.md §5). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface GoldenCase {
  fn: string;
  args: unknown[];
  /** JSON of the result; `{"$undefined": true}` when the function returned undefined. */
  result?: unknown;
  /** Set instead of `result` when the function threw. */
  error?: string;
}

/**
 * Inputs that expose JavaScript-vs-Python differences (PORT.md §6 P9, P10, P16).
 * Every string-taking function is exercised with all of them.
 */
export const EDGE_STRINGS: string[] = [
  "",
  " ",
  "  padded  ",
  "\t tab\nnewline \r\n",
  " nbsp ",
  "﻿bom",
  "İstanbul ılık ŞĞÇÖÜ şğçöü",
  "iı İI",
  "straße",
  "emoji 👗👠 dress",
  "👨‍👩‍👧 family",
  "٠١٢٣٤٥٦٧٨٩",
  "０１２３",
  "TR-100 432",
  "#tr100432/",
  "000123",
  "0000",
  "123456",
  "a".repeat(300),
  "line1\nline2",
  "trailing newline\n",
  "<script>alert(1)</script>",
  "it doesn't fit",
  "too tight",
  "wrong_size",
  "Wrong Size",
  "+90 555 123 45 67",
  "(555) 123-4567",
];

function plain(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value instanceof RegExp)
    return { $regexp: value.source, flags: value.flags };
  if (value instanceof Date) return { $date: value.toISOString() };
  return JSON.parse(JSON.stringify(value));
}

export class Recorder {
  private readonly cases: GoldenCase[] = [];

  constructor(private readonly module: string) {}

  /** Record `fn(...args)`; thrown errors are recorded rather than propagated. */
  call<A extends unknown[]>(
    name: string,
    fn: (...args: A) => unknown,
    ...args: A
  ): void {
    try {
      this.cases.push({
        fn: name,
        args: args.map(plain),
        result: plain(fn(...args)),
      });
    } catch (err) {
      this.cases.push({
        fn: name,
        args: args.map(plain),
        error: err instanceof Error ? err.constructor.name : String(err),
      });
    }
  }

  write(): void {
    const dir = join(process.cwd(), "python", "tests", "golden");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${this.module}.json`),
      // One case per line: compact, and diffs show exactly which case changed.
      "[\n" + this.cases.map((c) => JSON.stringify(c)).join(",\n") + "\n]\n",
    );
  }
}
