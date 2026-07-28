/**
 * Machine keys for merchant-created taxonomy entries (SPEC §8).
 *
 * Labels are free text in any language; the stable key that rules, sessions and
 * cases reference must be ASCII snake_case. Turkish characters are transliterated
 * rather than dropped, so "İade Talebi" becomes `iade_talebi` instead of `ade_talebi`.
 */

const TRANSLITERATIONS: Record<string, string> = {
  ı: "i",
  İ: "i",
  i: "i",
  ş: "s",
  Ş: "s",
  ğ: "g",
  Ğ: "g",
  ü: "u",
  Ü: "u",
  ö: "o",
  Ö: "o",
  ç: "c",
  Ç: "c",
  â: "a",
  é: "e",
  á: "a",
  í: "i",
  ó: "o",
  ú: "u",
  ñ: "n",
  ã: "a",
  õ: "o",
};

export function slugifyKey(input: string): string {
  const transliterated = [...input]
    .map((ch) => TRANSLITERATIONS[ch] ?? ch)
    .join("");

  return transliterated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

/** True when a key is safe to store and reference. */
export function isValidKey(key: string): boolean {
  return /^[a-z][a-z0-9_]{0,59}$/.test(key);
}
