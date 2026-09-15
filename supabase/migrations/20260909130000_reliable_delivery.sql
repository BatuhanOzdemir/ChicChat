alter table intake_sessions add column delivery_channel text not null default 'whatsapp'
  check (delivery_channel in ('whatsapp', 'simulator'));
alter table processed_messages add column customer_wa_id text;
update processed_messages p set customer_wa_id = m.customer_wa_id
  from conversation_messages m where p.merchant_id = m.merchant_id and p.message_id = m.wa_message_id;

create table message_outbox (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_wa_id text not null,
  delivery_key text not null,
  delivery_channel text not null check (delivery_channel in ('whatsapp', 'simulator')),
  payload jsonb not null,
  case_id uuid references cases(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  unique (merchant_id, delivery_key)
);
create index outbox_pending on message_outbox (merchant_id, customer_wa_id, id) where delivered_at is null;

create table message_inbox (
  id bigint generated always as identity primary key,
  merchant_id uuid not null references merchants(id) on delete cascade,
  customer_wa_id text not null,
  message_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  unique (merchant_id, message_id)
);
create index inbox_pending on message_inbox (id) where processed_at is null;
