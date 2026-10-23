import type { CalibrationInput, Frame, Source } from './api.ts';

export function learnEmptyFixture(frames: Frame[], startedAt: number, source: Source) {
  const rows = frames.filter(f => f.source === source && Date.parse(f.received_at) >= startedAt).sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  let window: Frame[] = [];
  for (const frame of rows) {
    const previous = window.at(-1);
    const valid = frame.levels.length === 2 && ['a', 'b'].every(sensor => frame.levels.some(l => l.sensor_id === sensor && l.status === 'ok' && l.distance_mm != null && Number.isFinite(l.distance_mm) && l.distance_mm >= 20 && l.distance_mm <= 4500));
    if (!valid) { window = []; continue; }
    if (previous && (frame.device_id !== previous.device_id || frame.boot_id !== previous.boot_id || frame.time_basis !== previous.time_basis || frame.sequence !== previous.sequence + 1 || Date.parse(frame.measured_at) <= Date.parse(previous.measured_at) || Date.parse(frame.measured_at) - Date.parse(previous.measured_at) > 5000)) window = [];
    window.push(frame);
  }
  // Keep enough samples to cover eight seconds even with a fast ESP32 stream.
  while (window.length > 20 && Date.parse(window.at(-1)!.measured_at) - Date.parse(window[1].measured_at) >= 8000) window.shift();
  const baseline = { a: 0, b: 0 }, noise = { a: 0, b: 0 };
  for (const sensor of ['a', 'b'] as const) {
    const distances = window.map(f => f.levels.find(l => l.sensor_id === sensor)!.distance_mm!).sort((a, b) => a - b);
    if (!distances.length) return { progress: 0, reason: 'Waiting for valid echoes from both sensors.', calibration: null, noise };
    if (distances.at(-1)! - distances[0] > 4) return { progress: 0, reason: 'Readings are moving by more than 4 mm. Keep the fixture empty and mounts still.', calibration: null, noise };
    const middle = Math.floor(distances.length / 2);
    baseline[sensor] = Math.round(((distances[middle] + distances[Math.floor((distances.length - 1) / 2)]) / 2) * 10) / 10;
    const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length;
    noise[sensor] = Math.sqrt(distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length);
  }
  const span = window.length ? Date.parse(window.at(-1)!.measured_at) - Date.parse(window[0].measured_at) : 0;
  const progress = Math.min(window.length / 20, span / 8000);
  const noiseMax = Math.max(noise.a, noise.b);
  const dry = Math.max(8, Math.ceil(noiseMax * 3));
  const calibration: CalibrationInput | null = progress >= 1 ? { source, empty_distance_mm: baseline, dry_threshold_mm: dry, wet_threshold_mm: Math.max(20, dry + 5, Math.ceil(noiseMax * 6)), stable_samples: 3, max_gap_ms: 5000 } : null;
  return { progress, reason: `${window.length} stable paired samples (minimum 20); ${(span / 1000).toFixed(1)}/8 seconds.`, calibration, noise };
}
