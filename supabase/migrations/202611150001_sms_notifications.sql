-- Add SMS without changing existing email preferences, jobs or sensor records.
begin;
alter table public.drain_email_preferences add column if not exists sms_enabled boolean not null default false;
alter table public.drain_email_preferences add column if not exists sms_phone text;
alter table public.drain_email_preferences drop constraint if exists drain_sms_phone;
alter table public.drain_email_preferences add constraint drain_sms_phone check((sms_phone is null or sms_phone ~ '^\+[1-9][0-9]{7,14}$') and (not sms_enabled or sms_phone is not null));
alter table public.drain_email_outbox add column if not exists channel text not null default 'email' check(channel in('email','sms'));
create or replace function public.queue_drain_email_events(p_record_id uuid,p_events jsonb)
returns void language plpgsql security invoker set search_path=public,pg_temp as $function$
declare r public.drain_records; pref public.drain_email_preferences; e jsonb; event_id text; threshold_value integer; delivery_channel text;
begin
 select * into r from public.drain_records where record_id=p_record_id and data_source='sensor' and schema_version=2 and calibration is not null;
 if not found or jsonb_typeof(p_events) is distinct from 'array' then return;end if;
 for e in select value from jsonb_array_elements(p_events) limit 5 loop
  if e->>'fixture_id' is distinct from r.fixture_id or e->>'record_id' is distinct from r.record_id::text then continue;end if;
  for pref in select p.* from public.drain_email_preferences p where p.fixture_id=r.fixture_id and (p.enabled or p.sms_enabled) and exists(select 1 from public.dm_device_members m where m.device_id=p.fixture_id and m.user_id=p.user_id and m.role='owner') loop
   foreach delivery_channel in array array['email','sms'] loop
   if not(case when delivery_channel='sms' then pref.sms_enabled else pref.enabled end)then continue;end if;
   threshold_value:=coalesce(pref.threshold_seconds,(e->>'threshold_seconds')::integer);
   if (e->>'elapsed_seconds')::numeric<threshold_value then continue;end if;
   perform pg_advisory_xact_lock(hashtextextended(pref.user_id::text||':'||r.fixture_id,0));
   event_id:=md5(pref.user_id::text||':'||(e->>'event_key')||case when delivery_channel='sms' then ':sms' else '' end);
   if exists(select 1 from public.drain_email_outbox o where o.id=event_id) then continue;end if;
   if exists(select 1 from public.drain_email_outbox o where o.fixture_id=pref.fixture_id and o.user_id=pref.user_id and o.channel=delivery_channel and o.created_at>now()-interval '1 hour' and o.status<>'cancelled')then continue;end if;
   insert into public.drain_email_outbox(id,fixture_id,user_id,event,channel)values(event_id,pref.fixture_id,pref.user_id,e||jsonb_build_object('email_threshold_seconds',threshold_value),delivery_channel)on conflict do nothing;
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
create or replace function public.claim_drain_notifications(p_limit integer default 10,p_channels text[] default array['email'])
returns setof public.drain_email_outbox language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
begin
 update public.drain_email_outbox set status='expired' where status in('pending','sending')and created_at<=now()-interval '23 hours';
 -- A crashed SMS send may have reached Twilio: do not resend it.
 update public.drain_email_outbox set status='failed' where channel='sms' and status='sending' and available_at<=now();
 return query with due as(select id from public.drain_email_outbox where channel=any(p_channels) and status in('pending','sending')and available_at<=now()and attempts<5 order by created_at limit least(greatest(p_limit,1),10) for update skip locked)
 update public.drain_email_outbox o set status='sending',attempts=o.attempts+1,available_at=now()+interval '90 seconds',lease_token=gen_random_uuid()from due where o.id=due.id returning o.*;
end;
$function$;
create or replace function public.update_drain_email(p_id text,p_lease uuid,p_action text,p_values jsonb)
returns void language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
begin
 if p_action='seal'then
  update public.drain_email_outbox set recipient=coalesce(recipient,p_values->>'recipient'),payload=coalesce(payload,p_values->'payload')where id=p_id and lease_token=p_lease and status='sending';
 elsif p_action in('sent','cancelled','failed')then
  update public.drain_email_outbox set status=p_action,provider_id=p_values->>'provider_id'where id=p_id and lease_token=p_lease and status='sending';
 elsif p_action='retry'then
  update public.drain_email_outbox set status=case when attempts>=5 then 'failed'else 'pending'end,available_at=now()+least(3600,30*power(2,attempts))::integer*interval '1 second'where id=p_id and lease_token=p_lease and status='sending';
 else raise exception 'Invalid email action';end if;
 if not found then raise exception 'Email lease expired';end if;
end;
$function$;
revoke all on function public.claim_drain_notifications(integer,text[]) from public,anon,authenticated;
grant execute on function public.claim_drain_notifications(integer,text[]) to service_role;
commit;
