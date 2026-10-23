# Next.js frontend

The home route redirects to `/insights`. The insights page focuses on graphs and essential controls, with sensor details collapsed. Existing layout styles and assets remain in place.

Use Node.js 24+, retain existing environment files, and run:

```sh
npm ci
npm run dev
```

Open http://localhost:3000 with the backend running. `NEXT_PUBLIC_BACKEND_URL` points to the backend; its CORS origins must permit this frontend. A configured backend API token can be entered in the existing form and stays in memory. Supabase secrets belong exclusively in `backend/.env`.

The typed client uses authenticated fetch streams, with tokens in headers, to receive source-filtered snapshots. The backend queries Supabase every second for open streams, including external writers. Reconnect restores the current snapshot; REST recovery and device discovery run every 15 seconds. Streams, retries and pending responses are canceled when device, source or token changes or the component unmounts.

Keep the fixture empty at startup for automatic calibration. Five stable consecutive samples spanning at least two seconds establish an empty baseline; the next sample uses it. The UI indicates when calibration is pending or saved. Stability cannot distinguish an empty fixture from still water. See the root README for calibration bounds and manual override behavior.

Run `npm run typecheck` and `npm run build` locally. The existing Google fonts need network access for the production build.

The optional `/api/events` proxy forwards JSON and caller Authorization to the backend. `BACKEND_URL` configures its server-side target; no credentials are injected. The drain-detail route remains a placeholder.

## Graph template

Visit `/insights` for a self-contained synthetic preview with scenario selection, a playback slider, stale-data simulation, distance/depth graphs, experimental short-term forecasts and test-duration bars. Choose Live Supabase data to use the existing authenticated backend stream. Preview data is clearly labeled and is never persisted. The same graph component is available on the home page. Graph styles are scoped to new components; original starter CSS is unchanged.

The live controls can collect a confirmed-empty baseline and start/finish controlled drainage tests. Calibration learns per-sensor median distances from at least 20 stable samples spanning eight seconds, estimates sample noise, and saves source-specific references. It times out after 30 seconds without qualifying evidence. It does not infer sink dimensions. The prior automatic startup calibration remains separately supported.

The graphs keep both sensors separate and show missing echoes as gaps. Forecasts are experimental local extrapolations, use the slower sensor, and are suppressed for stale, interrupted, noisy, flat or rising data. Existing completed sessions use the backend's frozen analysis. Historical test durations are descriptive and require comparable starting water levels and tap-off conditions; they are not a validated maintenance forecast. See the root README for model assumptions.

The primary graph now plots estimated seconds remaining against elapsed time. Solid segments show estimates computed only from readings available at each point; dashed segments show a projected countdown. Unknown estimates leave gaps. Actual completed test durations are labeled in seconds. Depth and distance plots are collapsed under Sensor measurements and calibration details.

## Supabase practice view

`/insights` now defaults to Supabase practice data. Run `npm run seed:practice` from the repository root once, keep the backend running, and select any of the six saved mock tests. The page reads 280 persisted frames through `/api/backend/api/v1/devices/...`, then plots the selected test from those responses. The replay slider does not generate new frames. Refresh explicitly with Read Supabase again; errors never trigger a synthetic-data fallback.

The same-origin gateway uses server-side `BACKEND_URL`, forwards optional caller Authorization, disables caching and allows only GET device/history/session routes. Supabase server credentials remain in the backend. Use Live Supabase data for the separate device stream, or Local synthetic preview for offline examples.
