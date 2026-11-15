-- Temporary per-browser live leases, separate from all measurement data.
begin;
create table if not exists public.drain_live_sessions(
 fixture_id text not null references public.dm_devices(device_id),session_id uuid not null,
 reason text not null check(reason in('demo','calibration')),expires_at timestamptz not null,
 primary key(fixture_id,session_id));
create table if not exists public.drain_live_devices(
 fixture_id text primary key references public.dm_devices(device_id),seen_at timestamptz not null,applied_at timestamptz);
alter table public.drain_live_sessions enable row level security;
alter table public.drain_live_devices enable row level security;
revoke all on public.drain_live_sessions,public.drain_live_devices from public,anon,authenticated;
grant select,insert,update,delete on public.drain_live_sessions,public.drain_live_devices to service_role;
create or replace function public.drain_live_mode(p_fixture text,p_action text,p_session uuid default null,p_reason text default null,p_applied boolean default false)
returns table(state jsonb) language plpgsql volatile security invoker set search_path=public,pg_temp as $function$
declare live_now timestamptz:=clock_timestamp(); expires timestamptz; device public.drain_live_devices;
begin
 if p_action not in('get','on','off','poll')then raise exception 'Invalid live action';end if;
 if p_action in('on','off')and p_session is null then raise exception 'Session required';end if;
 if p_action='on'then
  if p_reason is null or p_reason not in('demo','calibration')then raise exception 'Invalid live reason';end if;
  update public.drain_live_devices set applied_at=null where fixture_id=p_fixture and not exists(select 1 from public.drain_live_sessions where fixture_id=p_fixture and expires_at>live_now);
  delete from public.drain_live_sessions where fixture_id=p_fixture and expires_at<=live_now;
  insert into public.drain_live_sessions values(p_fixture,p_session,p_reason,live_now+interval '120 seconds')on conflict(fixture_id,session_id)do update set reason=excluded.reason,expires_at=excluded.expires_at;
 elsif p_action='off'then delete from public.drain_live_sessions where fixture_id=p_fixture and session_id=p_session;
 elsif p_action='poll'then
  insert into public.drain_live_devices values(p_fixture,live_now,case when p_applied then live_now else null end)
  on conflict(fixture_id)do update set seen_at=excluded.seen_at,applied_at=excluded.applied_at
  where drain_live_devices.seen_at<=live_now-interval '5 seconds' or (drain_live_devices.applied_at is not null) is distinct from p_applied;
 end if;
 select max(expires_at)into expires from public.drain_live_sessions where fixture_id=p_fixture;
 select * into device from public.drain_live_devices where fixture_id=p_fixture;
 return query select jsonb_build_object('now',extract(epoch from live_now)*1000,'expires_at',extract(epoch from expires)*1000,'seen_at',extract(epoch from device.seen_at)*1000,'applied_at',extract(epoch from device.applied_at)*1000);
end;
$function$;
revoke all on function public.drain_live_mode(text,text,uuid,text,boolean)from public,anon,authenticated;
grant execute on function public.drain_live_mode(text,text,uuid,text,boolean)to service_role;
commit;
