-- ChicChat — WhatsApp intake sessions (CLAUDE.md Step 8, Phase B).
--
-- Each WhatsApp inbound message is a separate request, so the intake state
-- machine's state is persisted between messages, keyed by (merchant, customer).
-- This is conversation-layer infra (§6), not part of the Phase-1 §4 sketch.

create table intake_sessions (
  id             uuid primary key default gen_random_uuid(),
  merchant_id    uuid        not null references merchants (id) on delete cascade,
  customer_wa_id text        not null,
  state          jsonb       not null,             -- serialized IntakeState
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (merchant_id, customer_wa_id)
);

create index idx_intake_sessions_merchant on intake_sessions (merchant_id);
