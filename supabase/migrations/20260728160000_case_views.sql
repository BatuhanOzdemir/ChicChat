-- ChicChat v0.2 Step 4 — case views & analytics (SPEC §8).
--
-- The merchant console needs to answer "how long did this intake take?" and to
-- list/filter cases efficiently.

-- When the customer's first message of this intake arrived. Null for cases
-- created before this migration (and shown as unknown rather than zero).
alter table cases
  add column intake_started_at timestamptz;

-- List and filter paths.
create index idx_cases_merchant_created on cases (merchant_id, created_at desc);
create index idx_cases_status on cases (merchant_id, status);
