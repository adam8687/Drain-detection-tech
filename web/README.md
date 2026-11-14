# Drain Monitor web

Node.js 24+. Run `npm ci` and `npm run dev` in this folder. `npm run typecheck`, `npm test` and `npm run build` validate the app. Nunito is loaded through Next fonts, so the production build needs font-download network access.

The frontend implements Smart Housing Figma page 166:25: Home (`181:2`), Dashboard (`181:258`), Heat map (`181:722`), Live View (`181:977`), and Add unit (`181:1192`). Exact exported SVG layers are local in `public/images/design/`; shared headers, wave layers and paper styling reuse those exports. Mobile layouts adapt the desktop frames. Fleet counts, search, filters, unit cards and heat-map tiles use actual accessible device data. Room/floor grouping is parsed from saved location names when available; no sample rooms are inserted. Work orders and alert muting remain visibly unavailable.

Routes: `/`, `/dashboard`, `/heat-map`, `/live-demo`, `/add-unit`, `/alerts`, `/login`; `/insights` redirects to Dashboard. Technical recording/replay controls remain under **Installer tools** on Dashboard. The account panel handles sign-in and sign-out; customer device setup stays in Add unit, with existing owner/viewer authorization preserved. The server gateway forwards caller authentication and can inject only a restricted read-only bench viewer, never an admin or sensor credential.

`/add-unit` checks one sensor, saves 20 stable empty-sink samples over at least eight seconds, and offers Start monitoring. No practice drains or running water are needed. Fixture URLs recover setup after refresh, and failed restores block actions until recovered. Historical dual-sensor calibration is not reused; the device needs a fresh empty check.

Live views use the backend's one-sensor water-depth curve, forecasts, gap markers and drain-cycle summaries. The empty baseline and learned usual drain time are distinct. Initial thresholds are 30 seconds for slowing and 60 seconds for water still present; usable comparable drain times can refine these later during normal use. Owner email preferences and server-side email delivery are implemented; the sender is not activated. SMS is not implemented.

Live pages request new readings after a cursor and recover using a 120-point snapshot; empty sinks refresh every 15 seconds and active/uncertain readings every three seconds; selector history refreshes every 60 seconds, fleet every 30 seconds. Hidden tabs pause polling. Finished recordings stop polling, and full replay remains available in Installer tools. Full measurement counts and elapsed-time origins are preserved in bounded responses. Apply `supabase/migrations/202611120001_single_sensor.sql` and `supabase/migrations/202611120002_email_notifications.sql` and deploy the corresponding backend/Edge Function with this frontend.

`npm run test:product` runs isolated consumer journeys; see `tests/README.md`. Simulated identity/readings never use live Supabase accounts or hardware.

## Customer setup and installer provisioning

Customer onboarding and account pages never issue, display, or ask the user to copy a device credential, backend token, recording UUID, or environment-file commands. Customers sign in normally; their sign-in session authenticates the app. The Add unit screen names the fixture, checks an already installed device, and records its empty baseline. Public Dashboard, Live View and Alerts authentication prompts link to sign-in rather than offering manual tokens.

Current prototype hardware still needs installer-side provisioning before handoff. Use the existing trusted USB/Wi-Fi setup tools to configure the fixture-scoped credential and uploader/firmware. Removing a customer key screen does not automatically provision or pair hardware. If a device is unprepared or offline, onboarding stays waiting and tells the customer to contact their installer. A consumer QR-claim / Wi-Fi pairing protocol is not implemented. Backend key-issuance APIs remain owner/admin protected for trusted tooling; sensor upload authentication has not been weakened.

Browser journeys provision their simulated sensor through an installer-side backend request, outside the customer browser, and assert that no customer page fetches a device key or asks for configuration commands.

Signup confirmation returns to `/login`, password recovery to `/reset-password`. New customer deployments leave `DRAIN_ENABLE_BENCH_VIEWER=false`. Email settings stay owner-only; disabled delivery is shown explicitly. See the Supabase README for the provisional email policy, verified-sender setup and outbox retry configuration.

## Deploying on Vercel

- **Project settings:** Framework Next.js, Root Directory `web`, Node.js 24.x (the package requires >=24). No `vercel.json` is needed.
- **Environment variables (Production and Preview):**
  - `SUPABASE_FUNCTION_URL` (server only): `https://PROJECT.supabase.co/functions/v1/drain-api`. Without it the same-origin gateway cannot reach any data and reports "The hosted API is not configured".
  - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: browser sign-in (publishable key only).
  - Leave `BACKEND_URL` unset (it points at a local Node backend that does not exist on Vercel), keep `DRAIN_ENABLE_BENCH_VIEWER=false`, and never put an admin token or service key in any variable that Vercel exposes to the browser.
- **Order of a release:** apply new SQL migrations, run `npm run cloud:deploy` (hosted function), then merge to `main` so Vercel builds the web app. The web app tolerates an older function, but the new onboarding needs the new function and migrations.
- **Supabase Auth:** the production origin must be the Site URL and be in the redirect allow-list (`npm run auth:setup` shows the settings; `--apply` needs project-management access).
- **Check a deployment:** `/dashboard` and `/login` return 200; `GET /api/backend/api/v1/devices` without a session returns 401 from the function (not 503).
