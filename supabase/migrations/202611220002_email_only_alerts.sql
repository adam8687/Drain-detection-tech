-- Keep previous settings and contact names while retiring text delivery.
begin;

alter table public.drain_email_preferences
 add column if not exists emergency_contacts jsonb not null default '[]'::jsonb
 check (jsonb_typeof(emergency_contacts)='array' and jsonb_array_length(emergency_contacts)<=5);
alter table public.drain_email_outbox add column if not exists contact_id uuid;
alter table public.drain_email_outbox add column if not exists channel text not null default 'email' check(channel in('email','sms'));
update public.drain_email_outbox set status='cancelled'
 where channel='sms' and status in('pending','sending');

create or replace function public.add_drain_emergency_contact(p_fixture text,p_user uuid,p_contact jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $function$
begin
 insert into public.drain_email_preferences as p(fixture_id,user_id,emergency_contacts)
 values(p_fixture,p_user,jsonb_build_array(p_contact))
 on conflict(fixture_id,user_id) do update set emergency_contacts=p.emergency_contacts||excluded.emergency_contacts
 where jsonb_array_length(p.emergency_contacts)<5
 and not exists(select 1 from jsonb_array_elements(p.emergency_contacts) c where c->>'email'=p_contact->>'email');
 return found;
end;
$function$;

create or replace function public.remove_drain_emergency_contact(p_fixture text,p_user uuid,p_id uuid)
returns void language sql security invoker set search_path=public,pg_temp as $function$
 update public.drain_email_preferences p
 set emergency_contacts=coalesce((select jsonb_agg(c.value order by c.position)
   from jsonb_array_elements(p.emergency_contacts) with ordinality c(value,position)
   where c.value->>'id'<>p_id::text),'[]'::jsonb)
 where p.fixture_id=p_fixture and p.user_id=p_user;
$function$;

create or replace function public.set_drain_emergency_contact_email(p_fixture text,p_user uuid,p_id uuid,p_patch jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $function$
begin
 update public.drain_email_preferences p
 set emergency_contacts=(select jsonb_agg(
   case when c.value->>'id'=p_id::text
     and (coalesce((c.value->>'email_enabled')::boolean,false)<>(p_patch->>'email_enabled')::boolean
       or (p_patch ? 'email' and c.value->>'email' is distinct from p_patch->>'email'))
    then c.value||p_patch else c.value end order by c.position)
   from jsonb_array_elements(p.emergency_contacts) with ordinality c(value,position))
 where p.fixture_id=p_fixture and p.user_id=p_user
 and exists(select 1 from jsonb_array_elements(p.emergency_contacts) c where c->>'id'=p_id::text
   and (not (p_patch->>'email_enabled')::boolean or coalesce(p_patch->>'email',c->>'email') is not null))
 and not exists(select 1 from jsonb_array_elements(p.emergency_contacts) c
   where c->>'id'<>p_id::text and c->>'email'=p_patch->>'email');
 return found;
end;
$function$;

revoke all on function public.add_drain_emergency_contact(text,uuid,jsonb),public.remove_drain_emergency_contact(text,uuid,uuid),public.set_drain_emergency_contact_email(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.add_drain_emergency_contact(text,uuid,jsonb),public.remove_drain_emergency_contact(text,uuid,uuid),public.set_drain_emergency_contact_email(text,uuid,uuid,jsonb) to service_role;

create or replace function public.queue_drain_email_events(p_record_id uuid,p_events jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $function$
declare
 r public.drain_records;
 pref public.drain_email_preferences;
 e jsonb;
 job record;
 event_id text;
 threshold_value integer;
begin
 select * into r from public.drain_records where record_id=p_record_id and data_source='sensor' and schema_version=2 and calibration is not null;
 if not found or jsonb_typeof(p_events) is distinct from 'array' then return; end if;
 if jsonb_array_length(p_events)=0 then return; end if;
 -- Serialize the cooldown check for deliveries to the same unit and address.
 perform pg_advisory_xact_lock(hashtextextended('drain-notifications:'||r.fixture_id,0));
 for e in select value from jsonb_array_elements(p_events) limit 5 loop
  if e->>'fixture_id' is distinct from r.fixture_id or e->>'record_id' is distinct from r.record_id::text then continue; end if;
  for pref in select p.* from public.drain_email_preferences p
   where p.fixture_id=r.fixture_id and (p.enabled or jsonb_array_length(p.emergency_contacts)>0)
   and exists(select 1 from public.dm_device_members m where m.device_id=p.fixture_id and m.user_id=p.user_id and m.role='owner')
  loop
   threshold_value:=coalesce(pref.threshold_seconds,(e->>'threshold_seconds')::integer);
   if (e->>'elapsed_seconds')::numeric<threshold_value then continue; end if;
   for job in
    select null::text as address,null::uuid as contact_id where pref.enabled
    union all select c->>'email',coalesce(c->>'subscription_id',c->>'id')::uuid
     from jsonb_array_elements(pref.emergency_contacts) c
     where c->>'email_enabled'='true' and c->>'email' is not null
   loop
    if exists(select 1 from public.drain_email_outbox o where o.fixture_id=pref.fixture_id
      and o.channel='email' and o.created_at>now()-interval '1 hour' and o.status<>'cancelled'
      and ((o.user_id=pref.user_id and o.contact_id is null and job.contact_id is null) or o.recipient=job.address))
    then continue; end if;
    event_id:=md5(pref.user_id::text||':'||(e->>'event_key')||
      case when job.contact_id is not null then ':email:contact:'||job.address else '' end);
    insert into public.drain_email_outbox(id,fixture_id,user_id,event,recipient,contact_id)
    values(event_id,pref.fixture_id,pref.user_id,e||jsonb_build_object('email_threshold_seconds',threshold_value),job.address,job.contact_id)
    on conflict do nothing;
   end loop;
  end loop;
 end loop;
end;
$function$;

create or replace function public.claim_drain_emails(p_limit integer default 10)
returns setof public.drain_email_outbox language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
begin
 update public.drain_email_outbox set status='expired' where status in('pending','sending')and created_at<=now()-interval '23 hours';
 return query with due as(select id from public.drain_email_outbox where channel='email' and status in('pending','sending')and available_at<=now()and attempts<5 order by created_at limit least(greatest(p_limit,1),10) for update skip locked)
 update public.drain_email_outbox o set status='sending',attempts=o.attempts+1,available_at=now()+interval '90 seconds',lease_token=gen_random_uuid()from due where o.id=due.id returning o.*;
end;
$function$;

-- Older workers may still call the channel-aware endpoint during rollout.
create or replace function public.claim_drain_notifications(p_limit integer default 10,p_channels text[] default array['email'])
returns setof public.drain_email_outbox language sql volatile security invoker set search_path=public,pg_temp as $function$
 select c.* from (select p_limit as batch_size where 'email'=any(p_channels)) requested
 cross join lateral public.claim_drain_emails(requested.batch_size) c;
$function$;
revoke all on function public.claim_drain_emails(integer),public.claim_drain_notifications(integer,text[]) from public,anon,authenticated;
grant execute on function public.claim_drain_emails(integer),public.claim_drain_notifications(integer,text[]) to service_role;

commit;
