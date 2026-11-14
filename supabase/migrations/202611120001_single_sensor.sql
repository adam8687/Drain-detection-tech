-- Apply after 202610270001_drain_records.sql and records_access.sql.
-- Stop old uploaders first; flash the single-sensor firmware before resuming.
-- Original two-channel rows are retained privately; finished timings stay frozen.
begin;
lock table public.drain_records in access exclusive mode;
create table if not exists public.drain_records_two_sensor_backup (
  record_id uuid primary key,
  original_record jsonb not null,
  saved_at timestamptz not null default now()
);
alter table public.drain_records_two_sensor_backup enable row level security;
revoke all on public.drain_records_two_sensor_backup from public, anon, authenticated;
grant select, insert on public.drain_records_two_sensor_backup to service_role;
alter table public.drain_records drop constraint if exists calibration_shape;
do $migration$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='drain_records' and column_name='schema_version') then
    insert into public.drain_records_two_sensor_backup(record_id,original_record)
      select record_id,to_jsonb(r) from public.drain_records r on conflict do nothing;
    alter table public.drain_records add column schema_version smallint not null default 1 check(schema_version in(1,2));
    update public.drain_records r set
      calibration = case when calibration is null then null else jsonb_build_object('empty_distance_mm',calibration->'sensor_a_empty_mm') end,
      measurements = coalesce((select jsonb_agg(jsonb_build_object('reading_id',p->'reading_id','timestamp',p->'timestamp','sensor',p->'sensor_a') order by position) from jsonb_array_elements(r.measurements) with ordinality as points(p,position)),'[]'::jsonb),
      result = case when recording_status='recording' and record_type='drainage' then '{"drainage_time_seconds":null,"outcome":"uncertain"}'::jsonb else result end,
      recording_status = 'finished';
  end if;
end;
$migration$;
alter table public.drain_records alter column schema_version set default 2;
alter table public.drain_records add column if not exists revision bigint not null default 0;
alter table public.drain_records add constraint calibration_shape check (
  calibration is null or case when jsonb_typeof(calibration)='object' and jsonb_typeof(calibration->'empty_distance_mm')='number'
  then calibration - 'empty_distance_mm' = '{}'::jsonb and (calibration->>'empty_distance_mm')::numeric between 20 and 4500 else false end
);
create or replace function public.valid_single_sensor_points(points jsonb)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $function$
declare point jsonb; sensor jsonb;
begin
  if jsonb_typeof(points) is distinct from 'array' then return false; end if;
  if jsonb_array_length(points)>5000 then return false; end if;
  for point in select value from jsonb_array_elements(points) loop
    if jsonb_typeof(point) is distinct from 'object' or not(point ?& array['reading_id','timestamp','sensor']) or point-array['reading_id','timestamp','sensor']<>'{}'::jsonb then return false; end if;
    if jsonb_typeof(point->'reading_id') is distinct from 'string' or jsonb_typeof(point->'timestamp') is distinct from 'string' then return false; end if;
    sensor:=point->'sensor';
    if jsonb_typeof(sensor) is distinct from 'object' or not(sensor ?& array['distance_mm','status']) or sensor-array['distance_mm','status']<>'{}'::jsonb then return false; end if;
    if sensor->>'status'='ok' then
      if jsonb_typeof(sensor->'distance_mm') is distinct from 'number' then return false; end if;
      if (sensor->>'distance_mm')::numeric not between 20 and 4500 then return false; end if;
    elsif sensor->>'status' in ('timeout','out_of_range') then
      if sensor->'distance_mm' is distinct from 'null'::jsonb then return false; end if;
    else return false;
    end if;
  end loop;
  return true;
end;
$function$;
alter table public.drain_records drop constraint if exists measurements_shape;
alter table public.drain_records add constraint measurements_shape check(public.valid_single_sensor_points(measurements));
create or replace function public.bump_drain_record_revision()
returns trigger language plpgsql set search_path=public,pg_temp as $function$
begin new.revision:=old.revision+1; return new; end;
$function$;
drop trigger if exists drain_record_revision on public.drain_records;
create trigger drain_record_revision before update on public.drain_records for each row execute function public.bump_drain_record_revision();
-- Acknowledgments contain only an ID and revision, never the growing history.
create or replace function public.update_drain_record_compact(p_record_id uuid,p_expected jsonb,p_changes jsonb)
returns table(record_id uuid,revision bigint)
language sql volatile security invoker set search_path=public,pg_temp as $function$
  update public.drain_records r set
    calibration=nullif(p_changes->'calibration','null'::jsonb),
    measurements=p_changes->'measurements', result=nullif(p_changes->'result','null'::jsonb),
    recording_status=p_changes->>'recording_status'
  where r.record_id=p_record_id and r.schema_version=2
    and r.measurements=p_expected->'measurements'
    and r.calibration is not distinct from nullif(p_expected->'calibration','null'::jsonb)
    and r.result is not distinct from nullif(p_expected->'result','null'::jsonb)
    and r.recording_status=p_expected->>'recording_status'
  returning r.record_id,r.revision;
$function$;
revoke all on function public.update_drain_record_compact(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.update_drain_record_compact(uuid,jsonb,jsonb) to service_role;
comment on column public.drain_records.calibration is 'Single sensor empty-sink reference: {empty_distance_mm:number}.';
comment on column public.drain_records.measurements is '[{reading_id:uuid,timestamp:ISO-UTC,sensor:{distance_mm:number|null,status:ok|timeout|out_of_range}}]';
comment on column public.drain_records.schema_version is '2: single-sensor capture; 1: archived dual-channel capture, explicitly converted using A; excluded from new drain-time learning.';
commit;
