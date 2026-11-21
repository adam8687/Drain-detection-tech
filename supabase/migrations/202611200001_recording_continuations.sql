begin;
alter table public.drain_records
  add column if not exists continued_from uuid,
  add column if not exists continued_in uuid,
  add column if not exists rollover_root uuid;

create or replace function public.set_monitoring_rollover_root() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if new.record_type='monitoring' and new.rollover_root is null then new.rollover_root:=new.record_id; end if;
  return new;
end;
$$;
drop trigger if exists monitoring_rollover_root on public.drain_records;
create trigger monitoring_rollover_root before insert on public.drain_records
  for each row execute function public.set_monitoring_rollover_root();

-- Close the source and create its successor in the same transaction. Raw
-- measurements remain in their original recording, and a manual stop wins.
create or replace function public.roll_monitoring_record(
  p_id uuid, p_next uuid, p_incoming integer, p_created_at timestamptz
) returns setof public.drain_records
language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare previous public.drain_records;
begin
  select * into previous from public.drain_records where record_id=p_id for update;
  if not found or previous.record_type <> 'monitoring' or previous.schema_version <> 2 then return; end if;
  if previous.continued_in is not null then
    return query select r.* from public.drain_records r where r.record_id=previous.continued_in;
    return;
  end if;
  if previous.recording_status <> 'recording' or p_incoming not between 1 and 20
    or jsonb_array_length(previous.measurements) + p_incoming <= 5000 then return; end if;
  update public.drain_records set recording_status='finished', continued_in=p_next where record_id=p_id;
  return query insert into public.drain_records(record_id,fixture_id,record_type,data_source,
    recording_status,calibration,measurements,created_at,schema_version,continued_from,rollover_root)
    values(p_next,previous.fixture_id,'monitoring',previous.data_source,'recording',previous.calibration,
      '[]'::jsonb,p_created_at,2,p_id,coalesce(previous.rollover_root,p_id)) returning *;
end;
$$;
revoke all on function public.roll_monitoring_record(uuid,uuid,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.roll_monitoring_record(uuid,uuid,integer,timestamptz) to service_role;
commit;
