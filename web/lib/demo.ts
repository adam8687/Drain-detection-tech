import type { Calibration, Frame, DrainTest } from './api';
export type Scenario = 'normal' | 'slow' | 'timeout' | 'rising';
export const demoCalibration: Calibration = { id: 'preview-calibration', device_id: 'preview-sink', created_at: '2026-10-23T12:00:00Z', empty_distance_mm: { a: 400, b: 420 }, wet_threshold_mm: 20, dry_threshold_mm: 8, stable_samples: 3, max_gap_ms: 5000 };
export function demoFrames(scenario: Scenario): Frame[] {
  return Array.from({ length: 81 }, (_, i) => {
    const second = i / 2;
    const depth = scenario === 'rising' ? 20 + second * 1.4 : Math.max(0, 100 - second * (scenario === 'slow' ? 1.25 : 2.5));
    const time = new Date(Date.parse('2026-10-23T12:01:00Z') + second * 1000).toISOString();
    const levels = (['a', 'b'] as const).map((sensor, index) => {
      const missing = scenario === 'timeout' && i >= 35 && i <= 42 && sensor === 'b';
      const local = Math.max(0, depth + Math.sin(i * 0.8 + index) * 0.35 + index * 0.5);
      return { sensor_id: sensor, status: missing ? 'timeout' as const : 'ok' as const, distance_mm: missing ? null : demoCalibration.empty_distance_mm[sensor] - local, depth_mm: missing ? null : local, quality: missing ? 'timeout' : 'ok' };
    });
    return { event_id: `preview-${i}`, device_id: 'preview-sink', boot_id: 'preview-boot', sequence: i, source: 'mock', captured_at: time, measured_at: time, received_at: time, time_basis: 'device_clock', calibration_id: demoCalibration.id, levels,
      readings: levels.map(l => l.status === 'ok' ? { sensor_id: l.sensor_id, status: 'ok', distance_mm: l.distance_mm! } : { sensor_id: l.sensor_id, status: 'timeout' }) as Frame['readings'] };
  });
}
export const demoTests: DrainTest[] = [39, 40, 38, 42, 48, 55].map((seconds, i) => ({ id: `preview-test-${i}`, device_id: 'preview-sink', source: 'mock', name: `Illustrative test ${i + 1}`, status: 'finished', started_at: new Date(Date.UTC(2026, 9, 17 + i, 12)).toISOString(), finished_at: new Date(Date.UTC(2026, 9, 17 + i, 12, 1)).toISOString(), calibration_id: demoCalibration.id, analysis: { outcome: 'completed', reason: 'Synthetic example, not observed performance', drain_duration_ms: seconds * 1000 } }));
