# Drain Monitor web

Node.js 24+. Run `npm ci` and `npm run dev` in this folder. The root page renders the Smart Housing landing page from the Figma “Home – Low-fi” frame (`76:787`). The existing dashboard remains at `/insights`. The landing page uses scoped CSS Modules, Inter, and direct exports of the original Figma illustration layers in `public/images/marketing/`. Booking, test-rig, pricing, and heat-map links currently return to `/` until destinations are supplied; Live demo and Log in open the existing dashboard.

The dashboard uses the single-table records API. Choose a fixture ID (default `practice-sink-v2`) and Simulation or Physical sensors, then select a recording. Replay requests historical computations from the backend; the browser does not calculate calibration, drainage outcomes or forecasts. Active recordings refresh automatically. Finished records can be replayed without treating archived points as live hardware.

Run `npm run seed:practice` from the root after applying the new Supabase migration to save the examples. Missing data and connection failures are displayed explicitly, without a local generated-data fallback.

Recording controls can start confirmed-empty calibration, drainage and monitoring, or finish an active record. The ESP32 or simulator supplies the measurements. Baseline learning and results remain on the backend. Set `BACKEND_URL` in `.env.local` for the server-side gateway; existing files should not be overwritten. Supabase sign-in sessions and caller-supplied backend tokens are forwarded and kept in memory; the gateway injects no privileged credentials. `NEXT_PUBLIC_BACKEND_URL` is no longer used.

`/api/backend/api/v1/records` and its allowlisted detail/measurement/finish routes proxy backend requests. They enforce request size limits and disable caching. The legacy `/api/events` endpoint now returns 410 with the replacement contract.

Run `npm run typecheck` and `npm run build` locally. Existing Google fonts require network access during the production build.

The upstream account panel remains available for sign-in, account creation, fixture registration and one-time sensor-key issuance. Owners can manage recordings; viewers can only read. Sensor keys are for measurement uploads, not browser browsing.
