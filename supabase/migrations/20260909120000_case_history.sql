-- Case meaning belongs to the case, not to today's editable taxonomy.
alter table cases
  add column category_key_snapshot text,
  add column category_label_snapshot text,
  add column subcategory_key_snapshot text;
update cases c set category_key_snapshot = cat.key, category_label_snapshot = cat.label
  from categories cat where cat.id = c.category_id;
update cases c set subcategory_key_snapshot = sub.key
  from subcategories sub where sub.id = c.subcategory_id;
update cases set category_key_snapshot = 'deleted_category', category_label_snapshot = 'Deleted category'
  where category_key_snapshot is null;
alter table cases alter column category_key_snapshot set not null,
  alter column category_label_snapshot set not null;

create function snapshot_case_taxonomy() returns trigger language plpgsql as $$
begin
  select key, label into new.category_key_snapshot, new.category_label_snapshot
    from categories where id = new.category_id and merchant_id = new.merchant_id;
  new.category_key_snapshot := coalesce(new.category_key_snapshot, 'deleted_category');
  new.category_label_snapshot := coalesce(new.category_label_snapshot, 'Deleted category');
  select key into new.subcategory_key_snapshot from subcategories where id = new.subcategory_id;
  return new;
end $$;
create trigger cases_snapshot before insert on cases for each row execute function snapshot_case_taxonomy();

alter table case_fields add column type_snapshot text,
  add column normalize_rule_snapshot text, add column sort_order_snapshot integer not null default 0;
update case_fields cf set type_snapshot = fd.type,
  normalize_rule_snapshot = fd.normalize_rule, sort_order_snapshot = fd.sort_order
  from cases c join field_defs fd on fd.category_id = c.category_id
  where cf.case_id = c.id and cf.field_key = fd.key;
create function snapshot_case_field() returns trigger language plpgsql as $$
begin
  select fd.type, fd.normalize_rule, fd.sort_order
    into new.type_snapshot, new.normalize_rule_snapshot, new.sort_order_snapshot
    from cases c join field_defs fd on fd.category_id = c.category_id
    where c.id = new.case_id and fd.key = new.field_key;
  new.sort_order_snapshot := coalesce(new.sort_order_snapshot, 0);
  return new;
end $$;
create trigger case_fields_snapshot before insert on case_fields for each row execute function snapshot_case_field();
