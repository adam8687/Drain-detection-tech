# Lossless data efficiency

This release reduces processing and database request size without reducing sensor
evidence. Sampling cadence, firmware payloads, calibration, alert thresholds,
notification preferences and the customer interface remain unchanged. It creates
no profiles and deletes no data. Raw recordings and lifetime drain summaries stay
available under the existing access controls.

## Changes

- Monitoring batches build one reading-ID index and sort once, instead of scanning
  and sorting the growing history separately for each reading. Duplicate IDs,
  conflicting bodies, late points, finished records and the 5,000-point limit keep
  their existing behavior. Calibration and drainage tests retain sequential
  processing so automatic completion occurs on the same reading.
- The Supabase adapter associates a revision with each exact returned snapshot.
  Prefix-preserving appends send only the added readings plus mutable metadata
  through `update_drain_record_incremental`. The database locks that revision and
  delegates to the existing mutation inside the same transaction. Existing
  constraint checks, notification enqueueing and notification references apply.
  Late points, replacements and snapshots without a revision use the original
  full comparison path. A missing incremental RPC falls back for five minutes;
  actual database errors and revision conflicts are not treated as success.
- Bounded live responses calculate graph coordinates and historical forecasts
  only for the requested points. The whole-record forecast, calibration, cycle
  detection, original elapsed times, gap markers and full replay are preserved.
  Points immediately before the visible window still inform each forecast.
- Completed standalone drainage tests now join monitoring cycles in the compact
  drain-event history. Failed summary saves are retried on subsequent uploads in
  the same worker, including duplicate uploads. This queue is bounded to 2,000
  events and 200 events per attempt. Raw evidence remains the recovery source
  across restarts or a prolonged outage.

## Deployment

Apply `supabase/migrations/202611150002_incremental_record_writes.sql` after
the existing single-sensor migration, then deploy the backend/Edge Function.
The migration is repeatable and does not rewrite existing rows. It delegates to
the installed compact mutation, including its email hooks when configured.
Application-first deployment is compatible: a missing RPC uses the old path.
No firmware update is required for these changes. A local build or test does not
apply SQL or deploy to hosted Supabase.

## Lifetime history recovery

An operator can preview existing compact event summaries for one fixture:

```sh
npm run history:reconcile -- --fixture UNIT
```

Add `--apply` to idempotently insert missing summaries from the preserved original
recordings. `--source simulation` can be used separately; physical sensor data is
the default. This uses the existing private backend configuration and never asks
customers for credentials. It is currently for Supabase storage. It processes 25
recordings per page and writes at most 200 events per request. Errors stop the
operation; rerun to resume safely. Re-run after importing older recordings or if
an import runs concurrently. It does not edit originals, recalibrate a fixture,
change alerts or send notifications. Existing event IDs are preserved rather than
overwritten. No deletion/retention job is enabled.

## Validation

```sh
npm --prefix backend test
PGLITE_MODULE_PATH=/path/to/@electric-sql/pglite/dist/index.js node supabase/tests/incremental-writes.mjs
HOURS=0.1 npm run egress:simulate
```

The simulator compares actual database-write request bytes against equivalent
full-array requests. `NO_INCREMENTAL_WRITES=1` models the old write path.
These are request bytes, not billed outgoing traffic. The simulator uses nominal
ten-point batches and omits hardware/network delays and drain-end flushes. It
does not simulate recording rollover; it omits daily extrapolation if its one
recording fills. It is not a production usage or quota guarantee.

## Remaining work

Firmware still samples at 500 ms and uploads ten-point batches or when a drain
ends. Idle summaries, continuous sampling during uploads and multi-ping filtering
are not enabled. Minute summaries require summary-aware empty-level, sensor-fault,
connection and silent-device checks, plus pre-event buffering and hardware tests.
They must not be introduced merely by dropping points or lengthening timers.

The fleet dashboard and heat map use a page of unit summaries and up to twelve
recent completed drains per unit from `drain_events`. Search applies across
authorized units. The latest reading time is recorded on ingest, so the fleet
view can show a stalled device without reading its raw measurement array.
The existing `/history` endpoint serves bounded longer-range
aggregates. Detailed recording views still retrieve the selected raw window and
can follow links to adjacent windows. The fleet status is a recent snapshot,
and the Alerts page still shows detailed alert history.

Apply `202611200001_recording_continuations.sql` and
`202611200002_fleet_summaries.sql` before deploying the API and web changes.
Rollover closes a full window and opens its successor atomically. The API carries
an unfinished drain into the next window for analysis. Both windows retain
their original readings. Existing recordings have no new continuation links,
since historical manual stops and automatic transitions used the same saved
status. Old summaries are preserved. Review history reconciliation for missing
events before using historical charts for analysis.
The JSON-array database representation still rewrites a row internally on append;
the new RPC removes repeated histories from network requests, not PostgreSQL WAL
or storage work. A separate append-only measurement store and archival policy
would be a later migration. Lifetime health summaries should be retained even if
idle raw-data retention is introduced later.
