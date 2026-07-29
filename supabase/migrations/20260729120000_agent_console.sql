-- ChicChat v0.2 Step 5 — agent case console (SPEC §9).
--
-- Three things the console needs and the schema did not have: somewhere to put
-- the routing decision (queue + priority), an audit trail of what agents did
-- (status changes and internal notes), and the conversation itself, so the
-- handoff can be read next to what the customer actually said.

-- 1. Routing outcome on the case (SPEC §3 -> §9 queue view) ------------------
alter table cases
  add column queue       text,
  add column priority    text not null default 'normal',
  -- Set when the case reaches a terminal status, so "how long was it open?" is
  -- answerable without replaying the event log.
  add column resolved_at timestamptz;

comment on column cases.queue is
  'Target queue from the matching routing rule; null = unrouted (general).';
comment on column cases.priority is
  'high | normal | low — constrained in lib/cases/routing, not by a CHECK, so
   the vocabulary can grow without a migration.';

-- `in_progress` and `closed` join the lifecycle for the agent console.
comment on column cases.status is
  'open | in_progress | needs_info | handed_off | escalated | resolved | closed | abandoned';

-- Queue view: unresolved cases of one queue, oldest first.
create index idx_cases_queue on cases (merchant_id, queue, status);

-- 2. Routing-rule precedence is the merchant's decision -----------------------
-- Evaluation is first-match-wins, so the order rules are evaluated in decides
-- where a case lands. Ordering by `created_at` did not work: rules written in
-- one transaction share a timestamp (`now()` is frozen per transaction), so
-- precedence fell back to the random uuid. Same pattern as field_defs (R21).
alter table routing_rules
  add column sort_order integer not null default 0;

-- Backfill deterministically so existing rules keep a stable, if arbitrary,
-- order until the merchant sets one.
update routing_rules rr
   set sort_order = ranked.rn
  from (
    select id, row_number() over (
             partition by category_id order by created_at, id
           ) as rn
      from routing_rules
  ) as ranked
 where ranked.id = rr.id;

create index idx_routing_rules_category_order
  on routing_rules (category_id, sort_order);

-- 3. Case events — status transitions, internal notes, routing decisions -----
-- One table, because the console renders them as a single timeline.
--
-- `clock_timestamp()`, not `now()`: these are append-only log rows read back in
-- insertion order, and `now()` is frozen for a whole transaction — two events
-- written in one transaction (a case's routing decision and its first status
-- change) would share a timestamp and come back in arbitrary order.
create table case_events (
  id          uuid        primary key default gen_random_uuid(),
  case_id     uuid        not null references cases (id) on delete cascade,
  kind        text        not null check (kind in ('status_change', 'note', 'routing')),
  from_status text,                                    -- status_change only
  to_status   text,                                    -- status_change only
  body        text,                                    -- note text, or a description of the decision
  -- No auth yet (Step 6/7): every console action is attributed to 'agent' and
  -- automatic ones to 'system'. Becomes a real user reference later.
  actor       text        not null default 'agent',
  created_at  timestamptz not null default clock_timestamp()
);

create index idx_case_events_case on case_events (case_id, created_at);

-- 4. Conversation transcript (SPEC §9 read-only transcript) ------------------
-- Rows are written as messages are processed, before a case exists, and are
-- stamped with `case_id` when the intake completes. Message bodies are customer
-- content and therefore subject to KVKK retention (SPEC §12) — enforcement of
-- `retention_months` is still open (docs/RETROFIT.md R13).
create table conversation_messages (
  id             uuid        primary key default gen_random_uuid(),
  merchant_id    uuid        not null references merchants (id) on delete cascade,
  customer_wa_id text        not null,
  case_id        uuid        references cases (id) on delete set null,
  direction      text        not null check (direction in ('inbound', 'outbound')),
  kind           text        not null,                 -- text | list | photo | flow | interactive | other
  body           text,                                 -- what was said, as plain text
  -- Inbound WhatsApp message id, for correlating with the logs (SPEC §10).
  wa_message_id  text,
  -- Insertion time, for the same reason as case_events above.
  created_at     timestamptz not null default clock_timestamp()
);

create index idx_conversation_messages_case
  on conversation_messages (case_id, created_at);

-- One transcript entry per inbound WhatsApp message, ever. The error path
-- re-records the customer's message (its transaction may have rolled back), and
-- this is what makes doing so safe.
create unique index idx_conversation_messages_inbound_once
  on conversation_messages (merchant_id, wa_message_id)
  where direction = 'inbound' and wa_message_id is not null;
-- Used to stamp a finished intake's messages, and to read a customer's history.
create index idx_conversation_messages_customer
  on conversation_messages (merchant_id, customer_wa_id, created_at);
