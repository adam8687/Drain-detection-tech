# Consumer journeys

Install the project's development dependencies and Playwright browsers, then run:

```sh
npx playwright install chromium webkit firefox
npm run test:product
```

Run from `web/`. The suite builds the application into `.next-product-test`, starts an isolated backend with an in-memory database, and exercises the real UI through the real same-origin API gateway. Sign-in-provider responses and sensor signals are simulated; no live account or fixture is changed. The normal `.next` build and environment files are not used for test credentials. Next-generated type/configuration files are restored after the run.

Coverage includes Chrome desktop, Android-sized Chrome, a 320-pixel phone, iPhone/iPhone SE/iPad layouts in WebKit, desktop WebKit, and desktop Firefox. WebKit approximates Safari's engine; these are browser emulations, not physical phone or embedded-hardware tests.

Each journey covers signup confirmation redirects, password recovery and reset, sign-in failure/recovery, registration, reload during connection testing, a failed sensor, unstable empty calibration, completion from the empty reference alone, failed setup restoration, monitoring, owner email preference saving with delivery disabled, a network outage and recovery, critical alerts, filter retention, acknowledgment, and existing-device recovery. Hidden tabs must stop refresh requests. Layout checks reject page-level horizontal overflow and missing artwork, and exercise the redesigned home, dashboard and heat map. Screenshots, failures and a JSON summary are saved to `/tmp/drain-product-tests` by default.

Optional environment variables:

- `PRODUCT_TEST_PROFILES`: comma-separated profile names from `product-journey.mjs`.
- `PRODUCT_TEST_OUTPUT`: output directory.
- `PRODUCT_TEST_PORT`: local web port (default 3127).
- `CHROME_PATH`: installed Chrome executable instead of Playwright Chromium.
- `PLAYWRIGHT_BROWSERS_PATH`: directory used by Playwright for downloaded browsers.

A passing run verifies the software flows. Physical US-100 readings under splashing, foam, differing fixture shapes, Wi-Fi setup, uninterrupted operation beyond the existing 5000-sample monitoring window, and external email delivery need separate validation or implementation.

On this Mac, Firefox cannot launch its renderer (sandbox/SWGL initialization error); it has not been verified. The other seven profiles are runnable with the documented profile filter.
