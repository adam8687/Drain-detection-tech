-- Per-user device ownership and per-sensor ingest keys.

begin;
create table public.dm_device_members (
  id uuid primary key,
  device_id text not null references public.dm_devices(device_id),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'viewer')),
  created_at timestamptz not null,
  payload jsonb not null,
  unique (device_id, user_id)
);
create index dm_device_members_user on public.dm_device_members(user_id);

create table public.dm_device_keys (
  key_hash text primary key,
  device_id text not null references public.dm_devices(device_id),
  created_at timestamptz not null,
  payload jsonb not null
);
create index dm_device_keys_device on public.dm_device_keys(device_id);
alter table public.dm_device_members enable row level security;
alter table public.dm_device_keys enable row level security;
revoke all on public.dm_device_members, public.dm_device_keys from anon, authenticated;
grant select, insert, update on public.dm_device_members, public.dm_device_keys to service_role;
commit;
