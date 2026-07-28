import { describe, expect, it } from "vitest";
import { maskPhone } from "./mask";

describe("maskPhone", () => {
  it("keeps only the last four digits", () => {
    expect(maskPhone("905352680403")).toBe("****0403");
    expect(maskPhone("+90 535 268 04 03")).toBe("****0403");
  });

  it("never leaks a short value in full", () => {
    expect(maskPhone("12")).toBe("****12");
    expect(maskPhone("")).toBe("****");
    expect(maskPhone("no digits here")).toBe("****");
  });
});
