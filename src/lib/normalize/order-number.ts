/**
 * Order-number normalization (SPEC.md §2).
 *
 * Runs the moment an order number is captured so agents never clean it and the
 * bot never re-asks. Strips separators/noise (spaces, `/`, `#`, `-`, ...),
 * uppercases, optionally strips leading zeros, and validates the result against
 * the merchant's configurable order-id regex.
 */

export interface NormalizeOrderNumberOptions {
  /**
   * Merchant order-id pattern (`merchant_config.order_id_regex`). When given,
   * the NORMALIZED value is validated against it. A string is compiled to a
   * RegExp; pass a RegExp directly to control flags.
   */
  pattern?: string | RegExp;
  /**
   * Strip leading zeros from the cleaned id ("per merchant pattern", §2).
   * Default true; disable for merchants with fixed-width zero-padded ids.
   */
  stripLeadingZeros?: boolean;
}

export interface OrderNumberResult {
  /** The original input, untouched. */
  raw: string;
  /** Cleaned, uppercased (and optionally zero-stripped) order number. */
  normalized: string;
  /** True when normalized is non-empty and matches `pattern` (if provided). */
  valid: boolean;
}

function toRegExp(pattern: string | RegExp): RegExp {
  return typeof pattern === "string" ? new RegExp(pattern) : pattern;
}

export function normalizeOrderNumber(
  raw: string,
  options: NormalizeOrderNumberOptions = {},
): OrderNumberResult {
  const { pattern, stripLeadingZeros = true } = options;

  // Uppercase, then drop everything that isn't A–Z / 0–9 (spaces, /, #, -, …).
  let normalized = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

  if (stripLeadingZeros && normalized.length > 0) {
    const stripped = normalized.replace(/^0+/, "");
    // Keep a single "0" if the id was all zeros.
    normalized = stripped.length > 0 ? stripped : "0";
  }

  const valid =
    normalized.length > 0 &&
    (pattern ? toRegExp(pattern).test(normalized) : true);

  return { raw, normalized, valid };
}
