-- ChicChat v0.2 Step 6 — multi-tenancy seam.
--
-- Inbound WhatsApp messages carry the `phone_number_id` of the number they were
-- sent to, and that is the only thing that identifies which merchant a message
-- belongs to. Until now the webhook hardcoded the demo merchant; this table is
-- the mapping that replaces it.
--
-- A merchant may run several numbers (a brand and its outlet line, a migration
-- from an old number), so this is a table rather than a column on `merchants`.
create table whatsapp_channels (
  id              uuid        primary key default gen_random_uuid(),
  merchant_id     uuid        not null references merchants (id) on delete cascade,
  -- Meta's id for the business number. UNIQUE is the tenancy invariant: one
  -- number belongs to exactly one merchant, enforced by the database rather
  -- than by whichever query happens to resolve it.
  phone_number_id text        not null unique,
  waba_id         text,
  -- Human-readable label for the console, e.g. '+90 555 000 00 01'.
  display_number  text,
  -- The number a merchant's replies go out from when it has several.
  is_primary      boolean     not null default true,
  created_at      timestamptz not null default now()
);

create index idx_whatsapp_channels_merchant
  on whatsapp_channels (merchant_id, is_primary);

-- Access tokens stay in the environment for now — per-merchant credentials
-- arrive with deployment secrets (Step 7) and the İkas connector (Step 9),
-- which is also where `oauth_token_ref` on `integrations` starts being used.
comment on table whatsapp_channels is
  'Maps an inbound phone_number_id to its merchant (SPEC §10). No secrets here.';
