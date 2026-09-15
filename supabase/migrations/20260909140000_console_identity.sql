create table console_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  password_hash text not null,
  enabled boolean not null default true
);
create table console_memberships (
  user_id uuid not null references console_users(id) on delete cascade,
  merchant_id uuid not null references merchants(id) on delete cascade,
  primary key (user_id, merchant_id)
);
create table console_sessions (
  token_hash text primary key,
  user_id uuid not null references console_users(id) on delete cascade,
  expires_at timestamptz not null
);
create table console_login_attempts (
  username text primary key,
  window_started_at timestamptz not null default now(),
  attempts integer not null default 0
);
