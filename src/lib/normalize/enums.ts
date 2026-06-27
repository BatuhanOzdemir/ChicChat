/**
 * Enum constraining (SPEC.md §2): subcategory / reason / condition / etc. are
 * constrained to the merchant's configured values. Matching is case-insensitive
 * by default and returns the canonical allowed value (not the user's casing).
 */

export interface ConstrainEnumOptions {
  /** Match ignoring case. Default true. */
  caseInsensitive?: boolean;
}

export interface EnumResult {
  raw: string;
  /** The matched canonical allowed value, or null when not allowed. */
  normalized: string | null;
  valid: boolean;
}

export function constrainEnum(
  raw: string,
  allowed: readonly string[],
  options: ConstrainEnumOptions = {},
): EnumResult {
  const { caseInsensitive = true } = options;
  const trimmed = raw.trim();

  const match = allowed.find((value) =>
    caseInsensitive
      ? value.toLowerCase() === trimmed.toLowerCase()
      : value === trimmed,
  );

  return { raw, normalized: match ?? null, valid: match !== undefined };
}
