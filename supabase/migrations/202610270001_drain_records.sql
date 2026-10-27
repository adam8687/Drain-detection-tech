-- New installs: this file alone creates the active schema.
-- Existing installs: this leaves ALL legacy dm_* tables untouched.
-- After applying, run npm run migrate:records while old writers are stopped.
begin;
create table public.drain_records (
  record_id uuid primary key,
  fixture_id text not null check (fixture_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  record_type text not null check (record_type in ('calibration','drainage','monitoring')),
  data_source text not null check (data_source in ('sensor','simulation')),
  recording_status text not null check (recording_status in ('recording','finished')),
  calibration jsonb,
  measurements jsonb not null default '[]'::jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  constraint calibration_shape check (calibration is null or (jsonb_typeof(calibration) = 'object' and calibration ?& array['sensor_a_empty_mm','sensor_b_empty_mm'])),
  constraint measurements_shape check (jsonb_typeof(measurements) = 'array' and jsonb_array_length(measurements) <= 5000),
  constraint result_shape check (result is null or (jsonb_typeof(result) = 'object' and result ?& array['drainage_time_seconds','outcome'] and result->>'outcome' in ('completed','incomplete','uncertain'))),
  constraint result_only_for_drainage check (record_type = 'drainage' or result is null),
  constraint result_only_when_finished check (recording_status = 'finished' or result is null)
);
create index drain_records_history on public.drain_records(fixture_id,data_source,created_at desc,record_id desc);
create index drain_records_calibration on public.drain_records(fixture_id,data_source,created_at desc) where record_type = 'calibration' and recording_status = 'finished' and calibration is not null;
create unique index drain_records_one_active on public.drain_records(fixture_id,data_source) where recording_status = 'recording';
alter table public.drain_records enable row level security;
revoke all on public.drain_records from anon, authenticated;
grant select, insert, update on public.drain_records to service_role;
comment on table public.drain_records is 'One row per calibration, drainage or monitoring recording. Backend validates points, deduplicates reading IDs and appends with optimistic concurrency.';
comment on column public.drain_records.created_at is 'Server ordering metadata, needed before a recording has its first measurement. Not a sensor timestamp.';
comment on column public.drain_records.calibration is 'Snapshot: {sensor_a_empty_mm:number,sensor_b_empty_mm:number}. No separate fixture or calibration table.';
comment on column public.drain_records.measurements is '[{reading_id:uuid,timestamp:ISO-UTC,sensor_a:{distance_mm:number|null,status:ok|timeout|out_of_range},sensor_b:{distance_mm:number|null,status:ok|timeout|out_of_range}}]';
comment on column public.drain_records.result is '{drainage_time_seconds:number|null,outcome:completed|incomplete|uncertain}; calculated by backend.';
-- Atomic compare-and-set prevents concurrent appends and finishes losing data.
-- A POST body supports large recordings without exceeding URL/header limits.
create function public.update_drain_record(p_record_id uuid, p_expected jsonb, p_changes jsonb)
returns setof public.drain_records
language sql volatile security invoker
set search_path = public, pg_temp
as $function$
  update public.drain_records r set
    calibration = nullif(p_changes->'calibration', 'null'::jsonb),
    measurements = p_changes->'measurements',
    result = nullif(p_changes->'result', 'null'::jsonb),
    recording_status = p_changes->>'recording_status'
  where r.record_id = p_record_id
    and r.measurements = p_expected->'measurements'
    and r.calibration is not distinct from nullif(p_expected->'calibration', 'null'::jsonb)
    and r.result is not distinct from nullif(p_expected->'result', 'null'::jsonb)
    and r.recording_status = p_expected->>'recording_status'
  returning r.*;
$function$;
revoke all on function public.update_drain_record(uuid,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.update_drain_record(uuid,jsonb,jsonb) to service_role;
commit;
