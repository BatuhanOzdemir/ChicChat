import type { ListRow } from "@/lib/whatsapp";

/** One rendered chat bubble in the simulator transcript. */
export interface TranscriptEntry {
  id: string;
  role: "customer" | "bot" | "system";
  text: string;
  /** Tappable rows when the bot sent a List Message. */
  options?: ListRow[];
  /** Renders as a photo bubble rather than plain text. */
  isPhoto?: boolean;
}

export interface MerchantOption {
  id: string;
  name: string;
  locale: string;
  rtl: boolean;
}
