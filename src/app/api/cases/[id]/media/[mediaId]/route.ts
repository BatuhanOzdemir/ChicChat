import { getDatabase } from "@/db/client";
import { casePhoto } from "@/db/media";
import { merchantContext } from "@/server/merchant/current";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; mediaId: string }> },
): Promise<Response> {
  const { id, mediaId } = await params;
  if (!/^[a-f0-9-]{36}$/i.test(id) || mediaId.length > 100)
    return new Response("Not found", { status: 404 });
  const db = getDatabase();
  const ctx = await merchantContext(db);
  const photo = ctx ? await casePhoto(db, ctx.current.id, id, mediaId) : null;
  if (!photo) return new Response("Photo unavailable", { status: 404 });
  return new Response(new Uint8Array(photo.content), {
    headers: {
      "Content-Type": photo.mime_type,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
