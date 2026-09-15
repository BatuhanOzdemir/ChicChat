import Image from "next/image";

export function EvidencePhotos({
  caseId,
  photos,
}: {
  caseId: string;
  photos: string[];
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {photos.map((mediaId) => {
        const src = `/api/cases/${encodeURIComponent(caseId)}/media/${encodeURIComponent(mediaId)}`;
        return (
          <figure key={mediaId} className="rounded border p-2">
            <a href={src} target="_blank" rel="noreferrer">
              <Image
                src={src}
                alt="Customer evidence"
                width={240}
                height={180}
                unoptimized
                className="max-h-48 object-contain"
              />
            </a>
            <figcaption className="text-xs text-zinc-500">
              Open photo · older unavailable media may need resending
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
