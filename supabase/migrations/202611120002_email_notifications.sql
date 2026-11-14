-- Apply after the single-sensor migration. No email is sent by applying SQL.
begin;
create table if not exists public.drain_email_references(fixture_id text not null references public.dm_devices(device_id),cycle_id text not null,started_at timestamptz not null,depth_mm double precision not null check(depth_mm>0),duration_seconds double precision not null check(duration_seconds>0 and duration_seconds<120),primary key(fixture_id,cycle_id));
alter table public.drain_email_references enable row level security;
revoke all on public.drain_email_references from public,anon,authenticated;
grant select,insert on public.drain_email_references to service_role;
create table if not exists public.drain_email_preferences(
 fixture_id text not null references public.dm_devices(device_id), user_id uuid not null references auth.users(id) on delete cascade,
 enabled boolean not null default false, threshold_seconds integer check(threshold_seconds between 30 and 3600),primary key(fixture_id,user_id)
);
create table if not exists public.drain_email_outbox(
 id text primary key,fixture_id text not null references public.dm_devices(device_id),user_id uuid not null references auth.users(id) on delete cascade,
 event jsonb not null,status text not null default 'pending' check(status in('pending','sending','sent','failed','cancelled','expired')),
 attempts integer not null default 0,available_at timestamptz not null default now(),created_at timestamptz not null default now(),lease_token uuid,
 recipient text,payload jsonb,provider_id text
);
create index if not exists drain_email_due on public.drain_email_outbox(available_at) where status in('pending','sending');
create index if not exists drain_email_cooldown on public.drain_email_outbox(fixture_id,user_id,created_at desc);
alter table public.drain_email_preferences enable row level security;
alter table public.drain_email_outbox enable row level security;
revoke all on public.drain_email_preferences,public.drain_email_outbox from public,anon,authenticated;
grant select,insert,update on public.drain_email_preferences,public.drain_email_outbox to service_role;
create or replace function public.queue_drain_email_events(p_record_id uuid,p_events jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $function$
declare r public.drain_records; pref public.drain_email_preferences; e jsonb; event_id text; threshold_value integer;
begin
 select * into r from public.drain_records where record_id=p_record_id and data_source='sensor' and schema_version=2 and calibration is not null;
 if not found or jsonb_typeof(p_events) is distinct from 'array' then return;end if;
 for e in select value from jsonb_array_elements(p_events) limit 5 loop
  if e->>'fixture_id' is distinct from r.fixture_id or e->>'record_id' is distinct from r.record_id::text then continue;end if;
  for pref in select p.* from public.drain_email_preferences p where p.fixture_id=r.fixture_id and p.enabled and exists(select 1 from public.dm_device_members m where m.device_id=p.fixture_id and m.user_id=p.user_id and m.role='owner') loop
   threshold_value:=coalesce(pref.threshold_seconds,(e->>'threshold_seconds')::integer);
   if (e->>'elapsed_seconds')::numeric<threshold_value then continue;end if;
   perform pg_advisory_xact_lock(hashtextextended(pref.user_id::text||':'||r.fixture_id,0));
   event_id:=md5(pref.user_id::text||':'||(e->>'event_key'));
   if exists(select 1 from public.drain_email_outbox o where o.id=event_id) then continue;end if;
   if exists(select 1 from public.drain_email_outbox o where o.fixture_id=pref.fixture_id and o.user_id=pref.user_id and o.created_at>now()-interval '1 hour' and o.status<>'cancelled')then continue;end if;
   insert into public.drain_email_outbox(id,fixture_id,user_id,event)values(event_id,pref.fixture_id,pref.user_id,e||jsonb_build_object('email_threshold_seconds',threshold_value))on conflict do nothing;
  end loop;
 end loop;
end;
$function$;
-- Sensor persistence and notification enqueue commit together. Lost HTTP replies
-- can be retried without losing an email event or queuing it twice.
create or replace function public.update_drain_record_compact(p_record_id uuid,p_expected jsonb,p_changes jsonb)
returns table(record_id uuid,revision bigint) language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
declare updated public.drain_records; sample jsonb;
begin
 update public.drain_records r set calibration=nullif(p_changes->'calibration','null'::jsonb),measurements=p_changes->'measurements',result=nullif(p_changes->'result','null'::jsonb),recording_status=p_changes->>'recording_status'
 where r.record_id=p_record_id and r.schema_version=2 and r.measurements=p_expected->'measurements'
 and r.calibration is not distinct from nullif(p_expected->'calibration','null'::jsonb)
 and r.result is not distinct from nullif(p_expected->'result','null'::jsonb)and r.recording_status=p_expected->>'recording_status'
 returning r.* into updated;
 if not found then return;end if;
 if updated.data_source='sensor'and updated.schema_version=2 and exists(select 1 from public.dm_devices where device_id=updated.fixture_id)then
  perform pg_advisory_xact_lock(hashtextextended('email-refs:'||updated.fixture_id,0));
  for sample in select value from jsonb_array_elements(coalesce(p_changes->'notification_references','[]'::jsonb))limit 50 loop
   if sample->>'fixture_id' is distinct from updated.fixture_id or (select count(*)from public.drain_email_references where fixture_id=updated.fixture_id)>=50 then continue;end if;
   insert into public.drain_email_references(fixture_id,cycle_id,started_at,depth_mm,duration_seconds)values(updated.fixture_id,sample->>'cycle_id',(sample->>'started_at')::timestamptz,(sample->>'depth_mm')::double precision,(sample->>'duration_seconds')::double precision)on conflict do nothing;
  end loop;
 end if;
 perform public.queue_drain_email_events(updated.record_id,coalesce(p_changes->'notification_events','[]'::jsonb));
 return query select updated.record_id,updated.revision;
end;
$function$;
create or replace function public.claim_drain_emails(p_limit integer default 10)
returns setof public.drain_email_outbox language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
begin
 update public.drain_email_outbox set status='expired' where status in('pending','sending')and created_at<=now()-interval '23 hours';
 return query with due as(select id from public.drain_email_outbox where status in('pending','sending')and available_at<=now()and attempts<5 order by created_at limit least(greatest(p_limit,1),10) for update skip locked)
 update public.drain_email_outbox o set status='sending',attempts=o.attempts+1,available_at=now()+interval '90 seconds',lease_token=gen_random_uuid()from due where o.id=due.id returning o.*;
end;
$function$;
create or replace function public.update_drain_email(p_id text,p_lease uuid,p_action text,p_values jsonb)
returns void language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
begin
 if p_action='seal'then
  update public.drain_email_outbox set recipient=coalesce(recipient,p_values->>'recipient'),payload=coalesce(payload,p_values->'payload')where id=p_id and lease_token=p_lease and status='sending';
 elsif p_action in('sent','cancelled')then
  update public.drain_email_outbox set status=p_action,provider_id=p_values->>'provider_id'where id=p_id and lease_token=p_lease and status='sending';
 elsif p_action='retry'then
  update public.drain_email_outbox set status=case when attempts>=5 then 'failed'else 'pending'end,available_at=now()+least(3600,30*power(2,attempts))::integer*interval '1 second'where id=p_id and lease_token=p_lease and status='sending';
 else raise exception 'Invalid email action';end if;
 if not found then raise exception 'Email lease expired';end if;
end;
$function$;
revoke all on function public.queue_drain_email_events(uuid,jsonb),public.claim_drain_emails(integer),public.update_drain_email(text,uuid,text,jsonb)from public,anon,authenticated;
grant execute on function public.queue_drain_email_events(uuid,jsonb),public.claim_drain_emails(integer),public.update_drain_email(text,uuid,text,jsonb)to service_role;
commit;
