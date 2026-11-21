begin;
alter table public.drain_records add column if not exists last_reading_at text;

create or replace function public.set_drain_record_last_reading() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  new.last_reading_at:=new.measurements->-1->>'timestamp';
  return new;
end;
$$;
drop trigger if exists drain_record_last_reading on public.drain_records;
create trigger drain_record_last_reading before insert or update of measurements on public.drain_records
  for each row execute function public.set_drain_record_last_reading();

update public.drain_records set last_reading_at=measurements->-1->>'timestamp'
where recording_status='recording' and last_reading_at is null and jsonb_array_length(measurements)>0;

create table if not exists public.drain_record_health (
  record_id uuid primary key references public.drain_records(record_id) on delete cascade,
  revision bigint not null,
  summary jsonb not null
);
alter table public.drain_record_health enable row level security;
revoke all on public.drain_record_health from public,anon,authenticated;
grant select,insert,update on public.drain_record_health to service_role;
create index if not exists drain_records_empty_reference on public.drain_records(fixture_id,data_source)
  where schema_version=2 and calibration is not null;

create or replace function public.save_drain_record_health(p_record_id uuid,p_revision bigint,p_summary jsonb)
returns table(saved boolean) language sql volatile security invoker set search_path=public,pg_temp as $$
  insert into public.drain_record_health(record_id,revision,summary)
  select r.record_id,r.revision,p_summary from public.drain_records r where r.record_id=p_record_id and r.revision=p_revision
  on conflict(record_id) do update set revision=excluded.revision,summary=excluded.summary
    where drain_record_health.revision<=excluded.revision
  returning true;
$$;

create or replace function public.drain_fleet_page(p_user uuid,p_viewer text,p_admin boolean,p_source text,p_after text,p_search text,p_limit integer)
returns table(device_id text,name text,record jsonb,empty_ready boolean,recent_drains jsonb,health jsonb,last_reading_at text)
language sql stable security invoker set search_path=public,pg_temp as $$
  with units as materialized (
    select * from (
      select d.device_id, coalesce(d.payload->>'name',d.device_id) name from public.dm_devices d
      where d.device_id>p_after and (p_admin or d.device_id=p_viewer or exists(
        select 1 from public.dm_device_members m where m.device_id=d.device_id and m.user_id=p_user))
        and (p_search='' or strpos(lower(d.device_id||' '||coalesce(d.payload->>'name','')),lower(p_search))>0)
      union all
      select distinct r.fixture_id,r.fixture_id from public.drain_records r
      where p_admin and p_source='simulation' and r.data_source=p_source and r.fixture_id>p_after
        and (p_search='' or strpos(lower(r.fixture_id),lower(p_search))>0)
        and not exists(select 1 from public.dm_devices d where d.device_id=r.fixture_id)
    ) candidates order by candidates.device_id limit least(greatest(p_limit,1),101)
  )
  select u.device_id,u.name,
    case when r.record_id is not null then jsonb_build_object('record_id',r.record_id,'record_type',r.record_type,
      'recording_status',r.recording_status,'created_at',r.created_at,'schema_version',r.schema_version) end,
    exists(select 1 from public.drain_records c where c.fixture_id=u.device_id and c.data_source=p_source
      and c.schema_version=2 and c.calibration is not null),
    coalesce(e.recent,'[]'::jsonb), h.summary,
    case when r.recording_status='recording' then r.last_reading_at end
  from units u
  left join lateral (
    select x.record_id,x.record_type,x.recording_status,x.created_at,x.schema_version,x.last_reading_at
    from public.drain_records x where x.record_id=coalesce(
      (select a.record_id from public.drain_records a where a.fixture_id=u.device_id and a.data_source=p_source and a.recording_status='recording'),
      (select a.record_id from public.drain_records a where a.fixture_id=u.device_id and a.data_source=p_source
       order by a.created_at desc,a.record_id desc limit 1))
  ) r on true
  left join public.drain_record_health h on h.record_id=r.record_id
  left join lateral (
    select jsonb_agg(jsonb_build_object('seconds',q.seconds,'started_at',q.started_at,'record_id',q.record_id)
      order by q.started_at desc,q.event_id desc) recent
    from (select d.seconds,d.started_at,d.record_id,d.event_id from public.drain_events d
      where d.fixture_id=u.device_id and d.data_source=p_source order by d.started_at desc,d.event_id desc limit 12) q
  ) e on true order by u.device_id;
$$;
revoke all on function public.save_drain_record_health(uuid,bigint,jsonb),public.drain_fleet_page(uuid,text,boolean,text,text,text,integer) from public,anon,authenticated;
grant execute on function public.save_drain_record_health(uuid,bigint,jsonb),public.drain_fleet_page(uuid,text,boolean,text,text,text,integer) to service_role;
commit;
