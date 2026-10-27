import { randomUUID } from 'node:crypto';

export const SIMULATION_CALIBRATION = Object.freeze({ sensor_a_empty_mm: 400, sensor_b_empty_mm: 420 });
export const SCENARIOS = ['normal', 'slow', 'pooling', 'timeout', 'gap', 'shallow', 'empty'];
// Engineering fixture only: noise and changing drainage shape are illustrative,
// not a validated fluid model or a prediction of US-100 hardware accuracy.
export function simulateMeasurements({ scenario = 'normal', start = Date.now(), seed = 42, makeId = () => randomUUID() } = {}) {
  if (!SCENARIOS.includes(scenario)) throw Error('Unknown simulation scenario');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const duration = scenario === 'slow' ? 70 : scenario === 'pooling' ? 48 : 38;
  const count = scenario === 'empty' ? 50 : Math.ceil((duration + 12) * 2);
  const points = [];
  for (let sample = 0; sample < count; sample++) {
    const elapsed = sample * 500 + (sample ? Math.round((random() - 0.5) * 40) : 0);
    const seconds = elapsed / 1000;
    if (scenario === 'gap' && seconds > 15 && seconds < 23) continue;
    const point = { reading_id: makeId(sample), timestamp: new Date(start + elapsed).toISOString() };
    for (const sensor of ['a', 'b']) {
      const lag = sensor === 'b' ? scenario === 'pooling' ? 7 : 0.3 : 0;
      const progress = Math.min(1, Math.max(0, seconds - lag) / duration);
      const depth = scenario === 'empty' ? 0 : scenario === 'shallow' ? Math.max(0, 4 - seconds * 0.3) : 100 * (1 - progress) ** 1.35;
      const noise = (random() - 0.5) * 2 + Math.sin(seconds * 2 + (sensor === 'b' ? 1 : 0)) * Math.exp(-seconds / 8);
      const failed = scenario === 'timeout' && sensor === 'b' && seconds > 12 && seconds < 15;
      const outOfRange = scenario === 'timeout' && sensor === 'a' && sample === 45;
      point[`sensor_${sensor}`] = failed || outOfRange ? { distance_mm: null, status: outOfRange ? 'out_of_range' : 'timeout' } : { distance_mm: Math.round(SIMULATION_CALIBRATION[`sensor_${sensor}_empty_mm`] - depth + noise), status: 'ok' };
    }
    points.push(point);
  }
  return points;
}
