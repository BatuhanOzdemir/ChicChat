-- Browser access goes through authorized Next.js routes, never direct PostgREST.
-- The server uses the database owner connection; no anonymous/authenticated policies exist.
do $$ declare t text; begin
  foreach t in array array['merchants','merchant_config','categories','subcategories',
    'field_defs','routing_rules','integrations','cases','case_fields','case_items',
    'intake_sessions','processed_messages','conversation_messages','case_events',
    'whatsapp_channels','message_inbox','message_outbox','conversation_media',
    'console_users','console_memberships','console_sessions','console_login_attempts']
  loop execute format('alter table %I enable row level security',t); end loop;
end $$;
