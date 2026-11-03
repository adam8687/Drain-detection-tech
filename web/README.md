# Drain Monitor web

Node.js 24+. Run `npm ci` and `npm run dev` in this folder. The root page renders the Smart Housing landing page from the Figma “Home – Low-fi” frame (`76:787`). The dashboard is at `/dashboard`, and sign-in is at `/login`. The old `/insights` URL redirects to `/dashboard`. The landing page uses scoped CSS Modules, Inter, and direct exports of the original Figma illustration layers in `public/images/marketing/`. Booking, test-rig, pricing, and heat-map links currently return to `/` until destinations are supplied; Live demo opens `/live-demo`; Log in opens `/login`.

The dashboard uses the single-table records API. Choose a fixture ID (default `practice-sink-v2`) and Simulation or Physical sensors, then select a recording. Replay requests historical computations from the backend; the browser does not calculate calibration, drainage outcomes or forecasts. Active recordings refresh automatically. Finished records can be replayed without treating archived points as live hardware.

Run `npm run seed:practice` from the root after applying the new Supabase migration to save the examples. Missing data and connection failures are displayed explicitly, without a local generated-data fallback.

Recording controls can start confirmed-empty calibration, drainage and monitoring, or finish an active record. The ESP32 or simulator supplies the measurements. Baseline learning and results remain on the backend. Set `BACKEND_URL` in `.env.local` for the server-side gateway; existing files should not be overwritten. Supabase sign-in sessions and caller-supplied backend tokens are forwarded and kept in memory; the gateway injects no privileged credentials. `NEXT_PUBLIC_BACKEND_URL` is no longer used.

`/api/backend/api/v1/records` and its allowlisted detail/measurement/finish routes proxy backend requests. They enforce request size limits and disable caching. The legacy `/api/events` endpoint now returns 410 with the replacement contract.

Run `npm run typecheck` and `npm run build` locally. Existing Google fonts require network access during the production build.

The upstream account panel remains available for sign-in, account creation, fixture registration and one-time sensor-key issuance. Owners can manage recordings; viewers can only read. Sensor keys are for measurement uploads, not browser browsing.

## Frontend folders and routes

- `app/page.tsx`: `/`, the public home page.
- `app/dashboard/page.tsx`: `/dashboard`, drainage recordings, replay, and controls.
- `app/login/page.tsx`: `/login`, the existing sign-in and account interface.
- `app/live-demo/`: `/live-demo`, the responsive Figma Live View connected to existing recordings.
- `app/insights/page.tsx`: compatibility redirect to `/dashboard`.
- `app/drains/[id]/page.tsx`: the existing drain-detail placeholder.
- `app/api/`: server-side gateways; these URLs are unchanged.
- `components/`: reusable interface pieces, including the account panel.
- `lib/`: API client and Supabase authentication.
- `public/images/marketing/`: original home-page artwork.

Page-specific styles stay beside their page as `page.module.css`. Global styles and the root layout stay in `app/`.

## Live View

`/live-demo` defaults to Physical sensors. Choose a fixture and recording, or explicitly switch to Simulation recordings to inspect existing simulated records. Active recordings refresh every 1.5 seconds. Saved recordings remain labeled as saved; no sample values replace unavailable data. The 7/30/90-day chart plots completed drainage durations by recording start date within the latest 200 source-specific summaries. Registry names are optional: if that endpoint is unavailable, accessible recordings remain selectable by fixture ID.

The water-level chart uses `computed.water_levels` from the updated backend, including backend-defined measurement-gap markers. It plots calibrated depths for sensors A and B against actual elapsed seconds. Restart the backend after updating this checkout. Existing API authentication and ownership checks remain in effect. Links from Recording controls include `fixture`, `record`, and `source` query parameters.

The tube and sink are original Figma illustrations, not live hardware diagrams. Drain status and baseline seconds use the backend’s drainage-status analysis when present. Baselines use early completed durations and do not normalize starting water level. Room/floor metadata, alert management, heat-map navigation, and work orders are not supplied by the current recording API. Their unavailable states are explicit; no prototype action writes fabricated events.

The shared mobile navigation uses a three-line disclosure button with Escape, outside-tap, and link-selection dismissal. Account forms, recording controls, and Live View use mobile touch targets and stack on narrow screens.
