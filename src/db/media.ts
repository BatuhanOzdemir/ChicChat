import type { Queryable } from "./database";

export async function savePhoto(
  db: Queryable,
  merchantId: string,
  phone: string,
  mediaId: string,
  photo: { content: Buffer; mimeType: string },
): Promise<void> {
  await db.query(
    `insert into conversation_media (merchant_id,customer_wa_id,media_id,content,mime_type)
    values ($1,$2,$3,$4,$5) on conflict (merchant_id,customer_wa_id,media_id) do nothing`,
    [merchantId, phone, mediaId, photo.content, photo.mimeType],
  );
}

export async function casePhoto(
  db: Queryable,
  merchantId: string,
  caseId: string,
  mediaId: string,
) {
  const { rows } = await db.query(
    `select m.content,m.mime_type from conversation_media m
    join cases c on c.id=m.case_id and c.merchant_id=m.merchant_id
    where c.merchant_id=$1 and c.id=$2 and m.media_id=$3`,
    [merchantId, caseId, mediaId],
  );
  return (
    (rows[0] as { content: Buffer; mime_type: string } | undefined) ?? null
  );
}
