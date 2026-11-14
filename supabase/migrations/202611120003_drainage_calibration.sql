-- Extends only drain_records.calibration. No new table, sensor field or data rewrite.
-- Existing empty-only calibration snapshots remain valid and are not marked ready.
begin;
create or replace function public.valid_drainage_bands(bands jsonb,ready boolean)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $function$
declare b jsonb;i integer:=0;
begin
 if jsonb_typeof(bands) is distinct from 'array' then return false;end if;
 if jsonb_array_length(bands)<>(case when ready then 4 else 0 end) then return false;end if;
 for b in select value from jsonb_array_elements(bands) loop
  if jsonb_typeof(b)is distinct from'object'or not(b ?& array['from_depth_mm','to_depth_mm','duration_seconds'])or b-array['from_depth_mm','to_depth_mm','duration_seconds']<>'{}'::jsonb then return false;end if;
  if b->'from_depth_mm' is distinct from to_jsonb(30-i*5)or b->'to_depth_mm' is distinct from to_jsonb(25-i*5)or jsonb_typeof(b->'duration_seconds')is distinct from'number'then return false;end if;
  if (b->>'duration_seconds')::numeric not between .001 and 86400 then return false;end if;i:=i+1;
 end loop;return true;
exception when others then return false;
end;
$function$;
create or replace function public.valid_calibration_with_drainage(c jsonb)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $function$
declare d jsonb;r jsonb;a jsonb;ready boolean;ids text[]:=array[]::text[];key text;
begin
 if c is null then return true;end if;
 if jsonb_typeof(c)is distinct from'object'or jsonb_typeof(c->'empty_distance_mm')is distinct from'number'or c-array['empty_distance_mm','drainage']<>'{}'::jsonb then return false;end if;
 if (c->>'empty_distance_mm')::numeric not between 20 and 4500 then return false;end if;
 if not(c?'drainage')then return true;end if;d:=c->'drainage';
 if jsonb_typeof(d)is distinct from'object'or not(d ?& array['version','method','status','upper_depth_mm','lower_depth_mm','runs','active_capture','baseline_duration_seconds','baseline_recession_mm_per_second','bands','repeatability_ratio','measured_at','last_issue'])or d-array['version','method','status','upper_depth_mm','lower_depth_mm','runs','active_capture','baseline_duration_seconds','baseline_recession_mm_per_second','bands','repeatability_ratio','measured_at','last_issue']<>'{}'::jsonb then return false;end if;
 if d->'version' is distinct from'1'::jsonb or d->>'method' is distinct from'tap_off_drawdown'or d->>'status'not in('collecting','ready')or d->'upper_depth_mm'is distinct from'30'::jsonb or d->'lower_depth_mm'is distinct from'10'::jsonb then return false;end if;
 if jsonb_typeof(d->'status')is distinct from'string'or jsonb_typeof(d->'runs')is distinct from'array'then return false;end if;
 ready:=d->>'status'='ready';
 if ready and(jsonb_array_length(d->'runs')<>2 or d->'active_capture'<>'null'::jsonb)or not ready and jsonb_array_length(d->'runs')>=2 then return false;end if;
 for r in select value from jsonb_array_elements(d->'runs')loop
  if jsonb_typeof(r)is distinct from'object'or not(r ?& array['capture_id','recording_id','from_reading_id','to_reading_id','confirmed_at','ended_at','duration_seconds','recession_mm_per_second','uncertainty_seconds','sample_count','bands'])or r-array['capture_id','recording_id','from_reading_id','to_reading_id','confirmed_at','ended_at','duration_seconds','recession_mm_per_second','uncertainty_seconds','sample_count','bands']<>'{}'::jsonb then return false;end if;
  foreach key in array array['capture_id','recording_id','from_reading_id','to_reading_id']loop if jsonb_typeof(r->key)is distinct from'string'then return false;end if;perform(r->>key)::uuid;end loop;
  if r->>'capture_id'=any(ids)then return false;end if;ids:=array_append(ids,r->>'capture_id');
  foreach key in array array['confirmed_at','ended_at']loop if jsonb_typeof(r->key)is distinct from'string'then return false;end if;perform(r->>key)::timestamptz;end loop;
  if (r->>'ended_at')::timestamptz<(r->>'confirmed_at')::timestamptz then return false;end if;
  foreach key in array array['duration_seconds','recession_mm_per_second','uncertainty_seconds','sample_count']loop if jsonb_typeof(r->key)is distinct from'number'then return false;end if;end loop;
  if(r->>'duration_seconds')::numeric not between .001 and 86400 or(r->>'recession_mm_per_second')::numeric not between .001 and 20000 or(r->>'uncertainty_seconds')::numeric not between 0 and 10 or(r->>'sample_count')::integer not between 3 and 5000 or not public.valid_drainage_bands(r->'bands',true)then return false;end if;
 end loop;
 a:=d->'active_capture';
 if a<>'null'::jsonb then
  if jsonb_typeof(a)is distinct from'object'or not(a ?& array['capture_id','recording_id','from_reading_id','confirmed_at','tap_off_confirmed','clear_drain_confirmed'])or a-array['capture_id','recording_id','from_reading_id','confirmed_at','tap_off_confirmed','clear_drain_confirmed']<>'{}'::jsonb or a->'tap_off_confirmed'is distinct from'true'::jsonb or a->'clear_drain_confirmed'is distinct from'true'::jsonb then return false;end if;
  foreach key in array array['capture_id','recording_id','from_reading_id']loop if jsonb_typeof(a->key)is distinct from'string'then return false;end if;perform(a->>key)::uuid;end loop;
  if jsonb_typeof(a->'confirmed_at')is distinct from'string'then return false;end if;perform(a->>'confirmed_at')::timestamptz;
 end if;
 if ready then
  foreach key in array array['baseline_duration_seconds','baseline_recession_mm_per_second','repeatability_ratio']loop if jsonb_typeof(d->key)is distinct from'number'then return false;end if;end loop;
  if(d->>'baseline_duration_seconds')::numeric not between .001 and 86400 or(d->>'baseline_recession_mm_per_second')::numeric not between .001 and 20000 or(d->>'repeatability_ratio')::numeric not between 1 and 1.301 or jsonb_typeof(d->'measured_at')is distinct from'string'then return false;end if;perform(d->>'measured_at')::timestamptz;
 else
  foreach key in array array['baseline_duration_seconds','baseline_recession_mm_per_second','repeatability_ratio','measured_at']loop if d->key is distinct from'null'::jsonb then return false;end if;end loop;
 end if;
 if d->'last_issue'<>'null'::jsonb and(jsonb_typeof(d->'last_issue')is distinct from'string'or length(d->>'last_issue')>250)then return false;end if;
 return public.valid_drainage_bands(d->'bands',ready);
exception when others then return false;
end;
$function$;
alter table public.drain_records drop constraint if exists calibration_shape;
alter table public.drain_records add constraint calibration_shape check(public.valid_calibration_with_drainage(calibration));
comment on column public.drain_records.calibration is 'Single-sensor empty_distance_mm and optional versioned drainage metric: two confirmed tap-off runs, matched-depth timings, mm/s recession rate, sampling uncertainty and readiness. No volumetric flow claim.';
commit;
