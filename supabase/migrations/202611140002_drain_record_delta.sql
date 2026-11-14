-- Read only what changed. A worker that already holds an older copy of a recording asks for the readings newer than
-- its last one plus the small mutable fields, instead of downloading the whole (rolling) history again. Egress then
-- grows with new data, not with recording size. Read-only; service role only; nothing is rewritten.
begin;
create or replace function public.drain_record_delta(p_record_id uuid,p_after text)
returns table(record_id uuid,revision bigint,total integer,tail jsonb,calibration jsonb,result jsonb,recording_status text)
language sql stable security invoker set search_path=public,pg_temp as $function$
  select r.record_id,r.revision,jsonb_array_length(r.measurements),
    coalesce((select jsonb_agg(e order by e->>'timestamp' collate "C",e->>'reading_id' collate "C")
              from jsonb_array_elements(r.measurements) e where (e->>'timestamp') collate "C" > p_after collate "C"),'[]'::jsonb),
    r.calibration,r.result,r.recording_status
  from public.drain_records r where r.record_id=p_record_id and r.schema_version=2;
$function$;
revoke all on function public.drain_record_delta(uuid,text) from public,anon,authenticated;
grant execute on function public.drain_record_delta(uuid,text) to service_role;
commit;
