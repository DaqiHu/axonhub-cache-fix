# Local Runtime Resilience Design

## Goal

Keep the AxonHub + cache-fix local gateway recoverable and diagnosable under
SQLite lock contention, upstream 5xx responses, and unexpected process exits.

## Scope

This design hardens the Windows runtime managed by this repository. It does not
change the user-configured one-day AxonHub request retention, migrate the
database backend, or automatically delete/vacuum live data.

## Architecture

### Service Supervision

`scripts/start.ps1` remains the operator entry point. Normal start launches one
hidden `scripts/supervise.ps1` process. The supervisor owns AxonHub and
cache-fix child processes where possible, records PID/start/exit/exit-code
events, and restarts a missing service with bounded exponential backoff.

AxonHub HTTP 5xx responses do not trigger process restarts. A restart occurs
only when the process/port disappears. cache-fix additionally restarts after
three consecutive unreachable or degraded `/health` probes.

### Logging

Before process start, logs larger than 100 MiB rotate through five generations.
The runtime captures cache-fix stdout, stderr, supervisor events, and AxonHub
stdout/stderr. `CACHE_FIX_DEBUG_LOG` and `CACHE_FIX_UPSTREAM_ERROR_LOG_PATH`
point into `~/axonhub/logs` so all operational evidence has one owner.

The built-in `upstream-error-log` is enabled for structured non-2xx status and
header records. A custom `upstream-error-body-log` extension records only
JSON-parsed non-2xx response bodies, extracts a bounded error code/message,
includes `ah-request-id`, and truncates serialized details to 4096 characters.
It is fail-open and never mutates the response.

### Health And Storage Monitoring

`scripts/runtime-health.ps1` reports service ports, cache-fix `/health`, DB/WAL/
SHM sizes, and operational log sizes. Default thresholds are:

- WAL warning: 1 GiB; critical: 2 GiB.
- cache-fix debug log warning: 100 MiB.
- supervisor/service log warning: 100 MiB.

Health reporting is read-only. It never checkpoints, deletes, vacuums, or
restarts a service.

### SQLite Configuration And Maintenance

AxonHub's SQLite DSN adds `_pragma=busy_timeout(10000)` while preserving WAL and
foreign-key settings. This absorbs short writer contention but is not treated
as a solution for unbounded WAL growth.

`scripts/maintain-db.ps1` is an explicit offline command. It refuses to run
while ports 8090 or 9801 listen. Preview is the default. `-Execute` creates a
timestamped SQLite backup, checkpoints/truncates WAL, runs `PRAGMA optimize`,
and optionally runs `VACUUM`. It does not delete request rows; AxonHub Storage
Policy remains the retention authority.

### Probe Isolation

Cache reports must not hold one giant read transaction over a full day of large
request bodies for summary-only output. `--summary` uses aggregate SQL without
loading request bodies. Detailed reports query only the requested time window
plus bounded state rows in batches so each read transaction is short.

## Error Handling

- Child start failures are logged and retried with capped backoff.
- Crash loops never spin faster than the configured cap.
- Log write and rotation failures are warnings and do not block service start.
- Unknown/non-JSON error bodies are covered by the built-in status logger and
  are not copied into the body log.
- Maintenance aborts before mutation when services are active or backup fails.

## Verification

- PowerShell unit tests cover port parsing, rotation, thresholds, backoff, and
  maintenance safety gates.
- Extension tests cover extraction, truncation, header correlation, fail-open,
  and response immutability.
- A proxy integration test sends repeated upstream 500 responses followed by a
  success and verifies `/health` remains available.
- A supervisor integration test kills a disposable fake child and verifies one
  bounded restart with exit evidence.
- Full extension/runtime tests and live `-Status` verification remain required.
