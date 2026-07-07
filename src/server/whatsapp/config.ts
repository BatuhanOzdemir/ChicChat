/**
 * WhatsApp Cloud API config from the environment (CLAUDE.md Step 8).
 * Secrets live in .env.local — never committed.
 */
export interface WhatsAppConfig {
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  appSecret?: string;
}

export function getWhatsAppConfig(): WhatsAppConfig {
  return {
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v22.0",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET || undefined,
  };
}
