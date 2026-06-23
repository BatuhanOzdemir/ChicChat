import { describe, expect, it } from "vitest";
import { ping } from "./health";

describe("ping", () => {
  it("returns pong", () => {
    expect(ping()).toBe("pong");
  });
});
