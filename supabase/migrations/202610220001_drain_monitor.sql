-- Apply once in Supabase SQL Editor. API keys cannot create database tables.
-- Dedicated names avoid touching existing application tables.
begin;
create table public.dm_devices (
  device_id text primary key,
  created_at timestamptz not null,
  payload jsonb not null
);
create table public.dm_calibrations (
  id uuid primary key,
  device_id text not null references public.dm_devices(device_id),
  created_at timestamptz not null,
  payload jsonb not null
);
create index dm_calibration_device on public.dm_calibrations(device_id, created_at desc);
create table public.dm_readings (
  event_id uuid primary key,
  device_id text not null references public.dm_devices(device_id),
  boot_id uuid not null,
  sequence integer not null check (sequence >= 0),
  source text not null check (source in ('mock', 'hardware')),
  measured_at timestamptz not null,
  received_at timestamptz not null,
  payload jsonb not null,
  unique (device_id, boot_id, sequence)
);
create index dm_readings_device_time on public.dm_readings(device_id, source, measured_at desc);
create table public.dm_sessions (
  id uuid primary key,
  device_id text not null references public.dm_devices(device_id),
  source text not null check (source in ('mock', 'hardware')),
  status text not null check (status in ('active', 'finished')),
  started_at timestamptz not null,
  payload jsonb not null
);
create unique index dm_one_active_session on public.dm_sessions(device_id, source) where status = 'active';
-- All browser/ESP32 traffic goes through our backend. No anonymous database access.
alter table public.dm_devices enable row level security;
alter table public.dm_calibrations enable row level security;
alter table public.dm_readings enable row level security;
alter table public.dm_sessions enable row level security;
revoke all on public.dm_devices, public.dm_calibrations, public.dm_readings, public.dm_sessions from anon, authenticated;
grant select, insert, update on public.dm_devices, public.dm_calibrations, public.dm_readings, public.dm_sessions to service_role;
commit;
