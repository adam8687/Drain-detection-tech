# Default Next.js frontend

This uses the official create-next-app App Router TypeScript/CSS starter page, layout, styles and SVG assets. Source: vercel/next.js, packages/create-next-app/templates/app/ts. Template license: TEMPLATE-LICENSE.txt. There is no custom sensor dashboard, polling or API-token input on the home page.

## Run

Use Node.js 24+. From the repository root:

```sh
cd web
npm install next@latest react@latest react-dom@latest
npm install --save-dev typescript @types/node @types/react @types/react-dom
npm --prefix .. run setup
npm run dev
```

Open http://localhost:3000. Next.js generates TypeScript configuration on first startup. Retain package-lock.json; later installs use npm ci. The stock layout uses next/font/google and needs font-download access. Installation, compilation and browser rendering were unavailable in the build environment and remain to be verified on your machine.

## Later integration

The backend requires Supabase. Apply the SQL migration, configure backend/.env, run npm run check:supabase and npm run verify:supabase, then npm start from the repository root. Its separate testing console is http://localhost:8000. The default Next.js page intentionally makes no API requests.

web/lib/api.ts retains the corrected DrainApi client for the design team. Requests disable caching, and the backend queries Supabase on each read. Use periodic fresh reads or SSE plus REST recovery when adding the live dashboard. SSE is process-local; polling is necessary to discover writes made outside the current API process. The stock Next.js page does not claim to display live data.

NEXT_PUBLIC_BACKEND_URL in web/.env.local should point to the backend. For another computer, use the backend's LAN/HTTPS URL and allow the frontend origin in backend CORS_ORIGINS. Never expose Supabase secrets or a backend token through NEXT_PUBLIC variables. Keep the prototype backend token in memory when the future UI supplies it.

The optional app/api/events/route.ts proxy forwards caller JSON and Authorization to backend /api/v1/readings; it does not inject privileged credentials. BACKEND_URL configures this Next.js server-side proxy. ESP32/mock producers may call the backend directly.

The drain-detail route remains a minimal placeholder. Use the separate backend console for calibration, raw readings and drainage-test inspection until the design team implements the dashboard.
