-- Run after the original migration, with older backend instances stopped.
-- Copies all legacy baselines into their fixtures, verifies every version,
-- then removes the redundant table. Any error rolls the transaction back.
begin;
do $migration$
declare
  fixture record;
  legacy record;
  version jsonb;
  versions jsonb;
  mock_cal jsonb;
  hardware_cal jsonb;
begin
  if to_regclass('public.dm_calibrations') is null then return; end if;
  lock table public.dm_devices, public.dm_calibrations in access exclusive mode;
  if exists (
    select 1 from public.dm_calibrations c left join public.dm_devices d using (device_id)
    where d.device_id is null
  ) then raise exception 'Orphan calibration; no records removed'; end if;

  for fixture in select * from public.dm_devices loop
    versions := coalesce(fixture.payload->'calibration_history', '{}'::jsonb);
    for version in select value from jsonb_each(coalesce(fixture.payload->'calibration', '{}'::jsonb)) loop
      if version->>'id' is not null then
        if versions ? (version->>'id') and versions->(version->>'id') <> version then
          raise exception 'Conflicting embedded calibration version; no records removed';
        end if;
        versions := versions || jsonb_build_object(version->>'id', version);
      end if;
    end loop;
    for legacy in select payload from public.dm_calibrations where device_id = fixture.device_id loop
      if versions ? (legacy.payload->>'id') and versions->(legacy.payload->>'id') <> legacy.payload then
        raise exception 'Conflicting legacy calibration version; no records removed';
      end if;
      versions := versions || jsonb_build_object(legacy.payload->>'id', legacy.payload);
    end loop;
    select value into mock_cal from jsonb_each(versions)
      where value->>'source' is null or value->>'source' = 'mock'
      order by (value->>'created_at')::timestamptz desc, key desc limit 1;
    select value into hardware_cal from jsonb_each(versions)
      where value->>'source' is null or value->>'source' = 'hardware'
      order by (value->>'created_at')::timestamptz desc, key desc limit 1;
    update public.dm_devices set payload = fixture.payload || jsonb_build_object(
      'calibration', jsonb_build_object('mock', mock_cal, 'hardware', hardware_cal),
      'calibration_history', versions - coalesce(mock_cal->>'id', '') - coalesce(hardware_cal->>'id', '')
    ) where device_id = fixture.device_id;
  end loop;

  if exists (
    select 1 from public.dm_calibrations c join public.dm_devices d using (device_id)
    where not (
      coalesce(d.payload->'calibration_history'->(c.id::text) = c.payload, false)
      or coalesce(d.payload->'calibration'->'mock' = c.payload, false)
      or coalesce(d.payload->'calibration'->'hardware' = c.payload, false)
    )
  ) then raise exception 'Calibration readback failed; no records removed'; end if;
  drop table public.dm_calibrations;
end
$migration$;
commit;
