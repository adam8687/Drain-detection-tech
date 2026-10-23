import type { Calibration, Frame, SensorId } from './api.ts';

export interface ForecastLine { sensor: SensorId; depth: number; rate: number; remaining: number; fit: number }
export interface Forecast { state: 'forecast' | 'dry' | 'withheld'; reason: string; remaining: number | null; lines: ForecastLine[] }

// Local linear extrapolation, not a trained blockage or maintenance model.
export function forecastDrainage(frames: Frame[], calibration: Calibration | null, stale: boolean): Forecast {
  const withheld = (reason: string): Forecast => ({ state: 'withheld', reason, remaining: null, lines: [] });
  if (!calibration) return withheld('Calibrate the empty fixture first.');
  if (stale) return withheld('Readings are stale; waiting for fresh measurements.');
  const sorted = [...frames].sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  const latest = sorted.at(-1);
  if (!latest) return withheld('Waiting for sensor readings.');
  if (latest.calibration_id !== calibration.id) return withheld('Waiting for readings using the current calibration.');
  const window: Frame[] = [];
  for (let i = sorted.length - 1; i >= 0 && window.length < 8; i--) {
    const f = sorted[i], newer = window.at(-1);
    if (f.device_id !== latest.device_id || f.boot_id !== latest.boot_id || f.source !== latest.source || f.time_basis !== latest.time_basis || f.calibration_id !== calibration.id) break;
    if (newer && (newer.sequence !== f.sequence + 1 || Date.parse(newer.measured_at) <= Date.parse(f.measured_at) || Date.parse(newer.measured_at) - Date.parse(f.measured_at) > (calibration.max_gap_ms ?? 5000))) break;
    if (f.levels.length !== 2 || !['a', 'b'].every(id => f.levels.some(l => l.sensor_id === id && l.quality === 'ok' && l.depth_mm !== null && Number.isFinite(l.depth_mm)))) break;
    window.push(f);
  }
  const dry = calibration.dry_threshold_mm ?? 8;
  const stable = calibration.stable_samples ?? 3;
  if (window.length >= stable && window.slice(0, stable).every(f => f.levels.every(l => l.depth_mm! <= dry))) {
    return { state: 'dry', reason: 'Both sensors are within the dry threshold for consecutive valid readings. This does not establish drain health.', remaining: 0, lines: [] };
  }
  if (window.length && window[0].levels.every(l => l.depth_mm! <= dry)) return withheld('Waiting for consecutive valid dry confirmation from both sensors.');
  if (window.length < 6) return withheld('Need at least six consecutive valid paired readings.');
  window.reverse();
  const start = Date.parse(window[0].measured_at);
  const times = window.map(f => (Date.parse(f.measured_at) - start) / 1000);
  if (times.at(-1)! < 2) return withheld('Need at least two seconds of uninterrupted readings.');
  const lines: ForecastLine[] = [];
  for (const sensor of ['a', 'b'] as const) {
    const depths = window.map(f => f.levels.find(l => l.sensor_id === sensor)!.depth_mm!);
    const depth = depths.at(-1)!;
    if (depth <= dry) { lines.push({ sensor, depth, rate: 0, remaining: 0, fit: 1 }); continue; }
    const meanT = times.reduce((a, b) => a + b, 0) / times.length;
    const meanD = depths.reduce((a, b) => a + b, 0) / depths.length;
    const slope = times.reduce((sum, t, i) => sum + (t - meanT) * (depths[i] - meanD), 0) / times.reduce((sum, t) => sum + (t - meanT) ** 2, 0);
    const variation = depths.reduce((sum, d) => sum + (d - meanD) ** 2, 0);
    const residual = depths.reduce((sum, d, i) => sum + (d - (meanD + slope * (times[i] - meanT))) ** 2, 0);
    const fit = variation > 0 ? 1 - residual / variation : 0;
    if (slope >= -0.2 || fit < 0.85 || depths.some((d, i) => i > 0 && d - depths[i - 1] > 4)) return withheld('Water is rising, too steady, or too irregular for a short-term forecast. Turn off inflow for a controlled test.');
    const remaining = (depth - dry) / -slope;
    if (remaining > 120) return withheld('The dry threshold is beyond the two-minute forecast horizon.');
    lines.push({ sensor, depth, rate: -slope, remaining, fit });
  }
  return { state: 'forecast', reason: 'Experimental estimate from the last eight valid readings; assumes no inflow and a continuing local drainage trend. Dry confirmation still requires consecutive readings from both sensors.', remaining: Math.max(...lines.map(l => l.remaining)), lines };
}

// Recreate only the estimate available at each timestamp; never use later readings.
export function drainageTimeSeries(frames: Frame[], calibration: Calibration | null, stale = false) {
  const rows = [...frames].sort((a, b) => Date.parse(a.measured_at) - Date.parse(b.measured_at));
  const wet = calibration?.wet_threshold_mm ?? 20;
  const startIndex = rows.findIndex(f => calibration && f.calibration_id === calibration.id && f.levels.some(l => l.quality === 'ok' && l.depth_mm != null && l.depth_mm >= wet));
  if (startIndex < 0) return [];
  const start = Date.parse(rows[startIndex].measured_at);
  return rows.slice(startIndex).map((frame, offset) => {
    const index = startIndex + offset;
    const forecast = forecastDrainage(rows.slice(startIndex, index + 1), calibration, stale && index === rows.length - 1);
    return { x: (Date.parse(frame.measured_at) - start) / 1000, y: forecast.remaining };
  });
}
