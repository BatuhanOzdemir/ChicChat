-- ChicChat v0.2 Step 3 — merchant-editable taxonomy (SPEC §§4, 8).
--
-- Adds what the editor needs: explicit field ordering (so intake asks in the
-- merchant's order rather than alphabetically), human labels for fields and
-- routing rules, and the KVKK/retention policy settings.

-- 1. Field ordering + label (RETROFIT R21) -----------------------------------
alter table field_defs
  add column sort_order integer not null default 0,
  add column label      text;

-- Backfill a stable order from the existing alphabetical behaviour so nothing
-- changes for already-seeded merchants until they reorder.
with ordered as (
  select id, row_number() over (partition by category_id order by key) * 10 as pos
    from field_defs
)
update field_defs f set sort_order = ordered.pos
  from ordered where ordered.id = f.id;

-- 2. Routing-rule label, so rules are identifiable in the editor -------------
alter table routing_rules
  add column label text;

-- 3. KVKK + retention policy (SPEC §§8, 12) ----------------------------------
alter table merchant_config
  add column kvkk_url         text,
  add column retention_months integer not null default 12;
