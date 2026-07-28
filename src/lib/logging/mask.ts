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
