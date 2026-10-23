export function distances(frame) {
  return frame.readings.map(r => ({
    sensor_id: r.sensor_id, status: r.status,
    distance_mm: r.status !== 'ok' ? null : r.distance_mm ?? r.echo_us * (331.3 + 0.606 * (frame.temperature_c ?? 20)) / 2000,
  }));
}
export function levels(frame, calibration) {
  return distances(frame).map(r => {
    if (r.status !== 'ok' || !calibration) return { ...r, depth_mm: null, quality: r.status !== 'ok' ? r.status : 'uncalibrated' };
    const depth = calibration.empty_distance_mm[r.sensor_id] - r.distance_mm;
    // A return beyond the known empty floor may be a multipath echo or a moved mount.
    if (depth < -20) return { ...r, depth_mm: null, quality: 'beyond_empty_baseline' };
    return { ...r, depth_mm: Math.round(Math.max(0, depth) * 10) / 10, quality: 'ok' };
  });
}
export function analyzeSession(session, frames, calibration) {
  if (!calibration) return { outcome: 'inconclusive', reason: 'No calibration', drain_duration_ms: null };
  const end = session.finished_at ? Date.parse(session.finished_at) : Infinity;
  const sorted = frames.filter(f => f.source === session.source && Date.parse(f.measured_at) >= Date.parse(session.started_at) && Date.parse(f.measured_at) <= end)
    .sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at) || a.sequence - b.sequence);
  let wetAt = null, dryAt = null, lastValid = null, dryCount = 0, completedAt = null, gap = false, invalid = 0, lastTime = null;
  for (const frame of sorted) {
    const time = Date.parse(frame.measured_at);
    // Distinct event IDs with the same timestamp are not independent stable samples.
    if (lastTime !== null && time === lastTime) continue;
    lastTime = time;
    const values = levels(frame, calibration);
    if (values.some(r => r.quality !== 'ok')) { invalid++; dryCount = 0; dryAt = null; continue; }
    const wet = values.every(r => r.depth_mm >= calibration.wet_threshold_mm);
    const dry = values.every(r => r.depth_mm <= calibration.dry_threshold_mm);
    if (wetAt === null) {
      if (!wet) continue;
      wetAt = time; lastValid = time;
    } else {
      if (time - lastValid > calibration.max_gap_ms) gap = true;
      lastValid = time;
    }
    if (dry) {
      if (dryCount === 0) dryAt = time;
      dryCount++;
      if (dryCount >= calibration.stable_samples) { completedAt = time; break; }
    } else { dryCount = 0; dryAt = null; }
  }
  const timingBasis = [...new Set(sorted.map(f => f.time_basis))];
  const mixedClocks = timingBasis.length > 1;
  const outcome = wetAt === null ? 'inconclusive' : completedAt === null ? 'incomplete' : gap || mixedClocks ? 'inconclusive' : 'completed';
  return {
    outcome,
    reason: wetAt === null ? 'Both sensors must first observe water above their wet threshold' : completedAt === null ? 'Stable dry readings have not been observed at both sensors' : gap ? 'A sampling gap exceeded max_gap_ms during drainage' : mixedClocks ? 'Device-clock and server-received timestamps were mixed in this test' : 'Both sensors reached their dry threshold for consecutive valid samples',
    drain_duration_ms: outcome === 'completed' ? dryAt - wetAt : null,
    wet_at: wetAt === null ? null : new Date(wetAt).toISOString(),
    dry_at: completedAt === null ? null : new Date(dryAt).toISOString(),
    completed_at: completedAt === null ? null : new Date(completedAt).toISOString(),
    invalid_frames: invalid, frame_count: sorted.length,
    timing_basis: timingBasis,
  };
}

// Startup calibration assumes the fixture is empty. Stability alone cannot prove it.
// Only persisted, consecutive samples from one source, boot and clock qualify.
export function emptyFixtureBaseline(frames) {
  if (frames.length < 5) return null;
  const window = frames.slice(0, 5).reverse();
  const first = window[0];
  const samples = [];
  for (let i = 0; i < window.length; i++) {
    const frame = window[i], previous = window[i - 1];
    if (frame.source !== first.source || frame.boot_id !== first.boot_id || frame.time_basis !== first.time_basis) return null;
    if (previous && (frame.sequence !== previous.sequence + 1 || Date.parse(frame.measured_at) <= Date.parse(previous.measured_at) || Date.parse(frame.measured_at) - Date.parse(previous.measured_at) > 5000)) return null;
    const values = distances(frame);
    if (values.some(r => r.status !== 'ok' || !Number.isFinite(r.distance_mm))) return null;
    samples.push(Object.fromEntries(values.map(r => [r.sensor_id, r.distance_mm])));
  }
  if (Date.parse(window.at(-1).measured_at) - Date.parse(first.measured_at) < 2000) return null;
  const baseline = {};
  for (const sensor of ['a', 'b']) {
    const values = samples.map(sample => sample[sensor]).sort((a, b) => a - b);
    if (values.at(-1) - values[0] > 4) return null;
    baseline[sensor] = Math.round(values[2] * 10) / 10;
  }
  return baseline;
}
