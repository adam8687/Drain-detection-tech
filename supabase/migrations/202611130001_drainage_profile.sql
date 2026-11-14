-- Per-sink drainage profile inside the existing drain_records.calibration JSON (no new table or column).
-- Drainage version 2 stores, once two confirmed clear-drain tap-off runs agree: expected time per depth band,
-- the allowance for normal variation and sensor noise, and the slow / severe / standing-water thresholds with
-- the repeat rule. The empty reference still only fixes water depth. Version 1 setups remain valid and unchanged.
begin;
create or replace function public.valid_drainage_profile(p jsonb)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $function$
declare b jsonb;pol jsonb;t jsonb;i integer:=0;k text;
begin
 if jsonb_typeof(p)is distinct from'object'or not(p ?& array['clear_drain_confirmed','noise_seconds','variation_seconds','policy','bands','total'])or p-array['clear_drain_confirmed','noise_seconds','variation_seconds','policy','bands','total']<>'{}'::jsonb then return false;end if;
 if p->'clear_drain_confirmed'is distinct from'true'::jsonb or jsonb_typeof(p->'noise_seconds')is distinct from'number'or jsonb_typeof(p->'variation_seconds')is distinct from'number'then return false;end if;
 if(p->>'noise_seconds')::numeric not between 0 and 10 or(p->>'variation_seconds')::numeric not between 0 and 86400 then return false;end if;
 pol:=p->'policy';
 if jsonb_typeof(pol)is distinct from'object'or not(pol ?& array['slow_ratio','severe_ratio','repeat_count','repeat_window','standing_water_margin_seconds'])or pol-array['slow_ratio','severe_ratio','repeat_count','repeat_window','standing_water_margin_seconds']<>'{}'::jsonb then return false;end if;
 foreach k in array array['slow_ratio','severe_ratio','repeat_count','repeat_window','standing_water_margin_seconds']loop if jsonb_typeof(pol->k)is distinct from'number'then return false;end if;end loop;
 if(pol->>'slow_ratio')::numeric not between 1.1 and 5 or(pol->>'severe_ratio')::numeric not between(pol->>'slow_ratio')::numeric and 10 or(pol->>'repeat_count')::numeric not between 2 and 5 or(pol->>'repeat_count')::numeric<>trunc((pol->>'repeat_count')::numeric)or(pol->>'repeat_window')::numeric not between(pol->>'repeat_count')::numeric and 10 or(pol->>'repeat_window')::numeric<>trunc((pol->>'repeat_window')::numeric)or(pol->>'standing_water_margin_seconds')::numeric not between 0 and 3600 then return false;end if;
 if jsonb_typeof(p->'bands')is distinct from'array'or jsonb_array_length(p->'bands')<>4 then return false;end if;
 for b in select value from jsonb_array_elements(p->'bands')loop
  if jsonb_typeof(b)is distinct from'object'or not(b ?& array['from_depth_mm','to_depth_mm','expected_seconds','variation_seconds','tolerance_seconds','slow_seconds'])or b-array['from_depth_mm','to_depth_mm','expected_seconds','variation_seconds','tolerance_seconds','slow_seconds']<>'{}'::jsonb then return false;end if;
  if b->'from_depth_mm'is distinct from to_jsonb(30-i*5)or b->'to_depth_mm'is distinct from to_jsonb(25-i*5)then return false;end if;
  foreach k in array array['expected_seconds','variation_seconds','tolerance_seconds','slow_seconds']loop if jsonb_typeof(b->k)is distinct from'number'then return false;end if;end loop;
  if(b->>'expected_seconds')::numeric not between .001 and 86400 or(b->>'variation_seconds')::numeric not between 0 and 86400 or(b->>'tolerance_seconds')::numeric not between 0 and 86400 or(b->>'slow_seconds')::numeric not between .001 and 432000 then return false;end if;
  i:=i+1;
 end loop;
 t:=p->'total';
 if jsonb_typeof(t)is distinct from'object'or not(t ?& array['expected_seconds','tolerance_seconds','slow_seconds','severe_seconds','standing_water_seconds'])or t-array['expected_seconds','tolerance_seconds','slow_seconds','severe_seconds','standing_water_seconds']<>'{}'::jsonb then return false;end if;
 foreach k in array array['expected_seconds','tolerance_seconds','slow_seconds','severe_seconds','standing_water_seconds']loop if jsonb_typeof(t->k)is distinct from'number'then return false;end if;end loop;
 if(t->>'expected_seconds')::numeric not between .001 and 86400 or(t->>'tolerance_seconds')::numeric not between 0 and 86400 or(t->>'slow_seconds')::numeric<=(t->>'expected_seconds')::numeric or(t->>'severe_seconds')::numeric<(t->>'slow_seconds')::numeric or(t->>'standing_water_seconds')::numeric not between .001 and 432000 or(t->>'severe_seconds')::numeric>432000 or(t->>'slow_seconds')::numeric>432000 then return false;end if;
 return true;
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
 if jsonb_typeof(d)is distinct from'object'or not(d ?& array['version','method','status','upper_depth_mm','lower_depth_mm','runs','active_capture','baseline_duration_seconds','baseline_recession_mm_per_second','bands','repeatability_ratio','measured_at','last_issue'])or d-array['version','method','status','upper_depth_mm','lower_depth_mm','runs','active_capture','baseline_duration_seconds','baseline_recession_mm_per_second','bands','repeatability_ratio','measured_at','last_issue','profile']<>'{}'::jsonb then return false;end if;
 if d->'version' not in('1'::jsonb,'2'::jsonb)or d->>'method' is distinct from'tap_off_drawdown'or d->>'status'not in('collecting','ready')or d->'upper_depth_mm'is distinct from'30'::jsonb or d->'lower_depth_mm'is distinct from'10'::jsonb then return false;end if;
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
 -- Version 1 predates profiles. Version 2 carries the sink profile once two clear-drain runs agree.
 if d->'version'='1'::jsonb and d?'profile'then return false;end if;
 if d->'version'='2'::jsonb then
  if not d?'profile'or ready<>(d->'profile'<>'null'::jsonb)then return false;end if;
  if ready and not public.valid_drainage_profile(d->'profile')then return false;end if;
 end if;
 return public.valid_drainage_bands(d->'bands',ready);
exception when others then return false;
end;
$function$;
alter table public.drain_records drop constraint if exists calibration_shape;
alter table public.drain_records add constraint calibration_shape check(public.valid_calibration_with_drainage(calibration));
comment on column public.drain_records.calibration is 'Single-sensor empty_distance_mm (water depth) and optional versioned drainage profile. Version 2 holds per-depth-band expected times, variation/noise allowance and alert thresholds captured from two confirmed tap-off runs on a clear drain. No volumetric flow claim.';
commit;
