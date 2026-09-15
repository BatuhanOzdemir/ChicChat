-- Evidence lives in private Postgres storage, never a public URL or public bucket.
create table conversation_media (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_wa_id text not null,
  media_id text not null,
  case_id uuid references cases(id) on delete cascade,
  content bytea not null check (octet_length(content)<=10485760),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  created_at timestamptz not null default clock_timestamp(),
  unique (merchant_id, customer_wa_id, media_id)
);
create index media_case on conversation_media(case_id);
