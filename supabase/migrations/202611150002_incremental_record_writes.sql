-- Lossless upload optimization. No table changes, deleted points or rewritten
-- recordings. The existing mutation remains authoritative for constraints and
-- transactional notification delivery (including later provider migrations).
begin;
create or replace function public.update_drain_record_incremental(
  p_record_id uuid, p_revision bigint, p_expected jsonb, p_changes jsonb
) returns table(record_id uuid, revision bigint)
language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
declare current_row public.drain_records; added jsonb;
begin
  added := p_changes->'append_measurements';
  if jsonb_typeof(added) is distinct from 'array' or jsonb_array_length(added)>20 then
    raise exception 'Expected at most 20 appended measurements';
  end if;
  select * into current_row from public.drain_records r
    where r.record_id=p_record_id and r.schema_version=2 and r.revision=p_revision
    for update;
  if not found then return; end if;
  -- Also check metadata so a caller cannot accidentally mutate a different
  -- in-memory snapshot using a valid revision.
  if current_row.calibration is distinct from nullif(p_expected->'calibration','null'::jsonb)
    or current_row.result is distinct from nullif(p_expected->'result','null'::jsonb)
    or current_row.recording_status is distinct from p_expected->>'recording_status' then return; end if;
  if jsonb_array_length(current_row.measurements || added)>5000 then
    raise exception 'Recording reached 5000 samples';
  end if;
  return query select u.record_id,u.revision from public.update_drain_record_compact(
    p_record_id,
    p_expected || jsonb_build_object('measurements',current_row.measurements),
    (p_changes - 'append_measurements') || jsonb_build_object('measurements',current_row.measurements || added)
  ) u;
end;
$function$;
revoke all on function public.update_drain_record_incremental(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.update_drain_record_incremental(uuid,bigint,jsonb,jsonb) to service_role;
commit;
