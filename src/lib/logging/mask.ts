/**
 * PII masking for logs (Handbook §5, SPEC §12): phone numbers are never logged
 * in full — only the last 4 digits survive.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return "****";
  if (digits.length <= 4) return `****${digits}`;
  return `****${digits.slice(-4)}`;
}

/** Sanitize diagnostic text, including formatted numbers and transport secrets. */
export function redactText(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|passcode|secret|access_token|refresh_token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi,
      "$1[redacted]",
    )
    .replace(/:\/\/[^\s/@]+:[^\s/@]+@/g, "://[redacted]@")
    .replace(
      /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|\+?\d(?:[\s().-]?\d){6,14}/gi,
      (value) =>
        /^[a-f0-9]{8}-/i.test(value) || /^\d{4}-\d{2}-\d{2}T/.test(value)
          ? value
          : maskPhone(value),
    );
}

/** Redact nested log metadata too; never serialize arbitrary objects unbounded. */
export function redactLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redactLog(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|passcode|secret|token|authorization|cookie/i.test(key)
          ? "[redacted]"
          : redactLog(item, depth + 1),
      ]),
    );
  }
  return value;
}
