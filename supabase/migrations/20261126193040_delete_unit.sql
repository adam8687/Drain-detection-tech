begin;

create function public.delete_drain_unit(p_device text, p_owner uuid)
returns table(deleted boolean)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform 1 from public.dm_devices where device_id = p_device for update;
  if not found then
    return query select false;
    return;
  end if;

  if p_owner is not null then
    perform 1 from public.dm_device_members
      where device_id = p_device and user_id = p_owner and role = 'owner'
      for update;
    if not found then
      return query select false;
      return;
    end if;
  end if;

  delete from public.drain_records_two_sensor_backup where original_record->>'fixture_id' = p_device;
  delete from public.drain_records where fixture_id = p_device;
  delete from public.drain_events where fixture_id = p_device;
  delete from public.drain_email_outbox where fixture_id = p_device;
  delete from public.drain_email_references where fixture_id = p_device;
  delete from public.drain_email_preferences where fixture_id = p_device;
  delete from public.drain_live_sessions where fixture_id = p_device;
  delete from public.drain_live_devices where fixture_id = p_device;
  -- These tables exist only on projects upgraded from the legacy API.
  if pg_catalog.to_regclass('public.dm_sessions') is not null then
    delete from public.dm_sessions where device_id = p_device;
    delete from public.dm_readings where device_id = p_device;
    delete from public.dm_calibrations where device_id = p_device;
  end if;
  delete from public.dm_device_keys where device_id = p_device;
  delete from public.dm_device_members where device_id = p_device;
  delete from public.dm_devices where device_id = p_device;
  return query select true;
end;
$function$;

revoke all on function public.delete_drain_unit(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_drain_unit(text, uuid) to service_role;
commit;
