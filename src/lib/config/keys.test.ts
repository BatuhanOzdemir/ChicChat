import { describe, expect, it } from "vitest";
import { isValidKey, slugifyKey } from "./keys";

describe("slugifyKey", () => {
  it("turns a label into snake_case", () => {
    expect(slugifyKey("Return request")).toBe("return_request");
    expect(slugifyKey("Wrong / damaged / missing item")).toBe(
      "wrong_damaged_missing_item",
    );
  });

  it("transliterates Turkish characters instead of dropping them", () => {
    expect(slugifyKey("İade Talebi")).toBe("iade_talebi");
    expect(slugifyKey("Kargo Şikâyeti")).toBe("kargo_sikayeti");
    expect(slugifyKey("Ödeme sorunu")).toBe("odeme_sorunu");
  });

  it("trims separators and caps length", () => {
    expect(slugifyKey("  --hello--  ")).toBe("hello");
    expect(slugifyKey("a".repeat(80)).length).toBe(60);
  });

  it("returns an empty string when there is nothing usable", () => {
    expect(slugifyKey("!!!")).toBe("");
    expect(slugifyKey("")).toBe("");
  });
});

describe("isValidKey", () => {
  it("accepts snake_case keys starting with a letter", () => {
    expect(isValidKey("return_request")).toBe(true);
    expect(isValidKey("a1")).toBe(true);
  });

  it("rejects empty, leading-digit, or punctuated keys", () => {
    expect(isValidKey("")).toBe(false);
    expect(isValidKey("1abc")).toBe(false);
    expect(isValidKey("has space")).toBe(false);
    expect(isValidKey("Has_Upper")).toBe(false);
  });
});
