import type { DrainApi, Source } from './api';

// Uses the API client so views share the same auth, units and cache policy.
export async function loadReadings(api: DrainApi, deviceId: string, source: Source) {
  const [device, history, tests] = await Promise.all([
    api.device(deviceId, source), api.history(deviceId, source, 120), api.tests(deviceId),
  ]);
  return { device, readings: history.readings, tests: tests.sessions.filter(test => test.source === source) };
}
