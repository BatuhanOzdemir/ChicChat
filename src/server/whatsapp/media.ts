import type { WhatsAppConfig } from "./config";

export interface Photo {
  content: Buffer;
  mimeType: string;
}
const LIMIT = 10 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Download promptly; short-lived Meta URLs are never exposed to the browser. */
export async function downloadPhoto(
  config: WhatsAppConfig,
  mediaId: string,
  request: typeof fetch = fetch,
): Promise<Photo> {
  if (!/^\d{1,80}$/.test(mediaId)) throw new Error("invalid media identifier");
  const headers = { Authorization: `Bearer ${config.accessToken}` };
  const response = await request(
    `https://graph.facebook.com/${config.graphVersion}/${mediaId}`,
    {
      headers,
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    },
  );
  if (!response.ok)
    throw new Error(`Media lookup failed (HTTP ${response.status})`);
  const metadata: unknown = await response.json();
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("url" in metadata) ||
    typeof metadata.url !== "string"
  )
    throw new Error("invalid media metadata");
  const url = new URL(metadata.url);
  // Trust only Meta's HTTPS media hosts, without redirects or user credentials.
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !["facebook.com", "fbcdn.net", "fbsbx.com"].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error("untrusted media host");
  const media = await request(url, {
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const mimeType = media.headers.get("content-type")?.split(";")[0] ?? "";
  if (!media.ok || !TYPES.has(mimeType) || !media.body)
    throw new Error("unsupported or unavailable photo");
  const reader = media.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) throw new Error("photo exceeds 10 MB");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { content: Buffer.concat(chunks), mimeType };
}
