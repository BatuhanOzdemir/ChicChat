-- ChicChat v0.2 Step 2 — hardening (SPEC §§11–13).
--
-- Adds: merchant-configurable inactivity thresholds, session lifecycle state
-- (nudged / errored) and an idempotency ledger keyed by WhatsApp message id.

-- 1. Merchant-configurable inactivity thresholds (SPEC §11 defaults) ---------
alter table merchant_config
  add column nudge_after_minutes  integer not null default 5,
  add column abandon_after_hours  integer not null default 24;

-- 2. Session lifecycle -------------------------------------------------------
alter table intake_sessions
  add column status     text not null default 'active'
    check (status in ('active', 'nudged', 'errored')),
  add column nudged_at  timestamptz,
  add column last_error text;

-- The maintenance job scans by (status, last activity).
create index idx_intake_sessions_status_updated
  on intake_sessions (status, updated_at);

-- 3. Idempotency ledger (SPEC §11: duplicates never create duplicates) -------
create table processed_messages (
  id           uuid primary key default gen_random_uuid(),
  merchant_id  uuid        not null references merchants (id) on delete cascade,
  message_id   text        not null,
  processed_at timestamptz not null default now(),
  unique (merchant_id, message_id)
);

create index idx_processed_messages_merchant on processed_messages (merchant_id);

-- 4. `abandoned` joins the case lifecycle (SPEC §11). The column has no CHECK
--    constraint, so this documents the vocabulary rather than widening it.
comment on column cases.status is
  'open | needs_info | handed_off | escalated | resolved | abandoned';
