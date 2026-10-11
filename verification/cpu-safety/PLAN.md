# Independent CPU safeguard verification

Run `npm run verify:cpu` for isolated acceptance tests. Run
`npm run verify:cpu:production` for read-only production evidence using the
existing Wrangler login, including a 60-second live observation window.
Each command writes a timestamped JSON report in this directory and exits
nonzero on a failed assertion or harness failure. The production event sample
is observational: zero observed events is not a pass or a failure of scheduling.

## Method and pass criteria (written before running the audit)

Use public `createWorker().fetch()` and `.scheduled()` entry points with the real
database schema in a disposable local D1 instance. Do not import budget helpers,
limits, or their existing tests: expected thresholds below are the stated product
requirements, expressed independently. Seed only the disposable database to reach
boundary conditions. Real source adapters receive synthetic HTTP responses.
Outbound external fetches are intercepted, counted, and refused. No real emails,
production writes, deliberate production exhaustion, or deployment occur.

1. Ordinary mutations reserve exactly 500 ms; reads and invalid-origin requests
   do not reserve. Explicitly record the latter as an accounting exclusion.
2. Race 20 public requests with only one 500 ms reservation remaining. Exactly
   one reaches validation, 19 return 429, persisted usage never exceeds 21M.
3. At 21M, every known mutation route returns 429, inbox reads remain available,
   scheduled scans/maintenance do no source or external network work, queued
   email remains untouched, and reopening the app cannot reset usage.
4. A missing accounting table blocks mutations and scheduled scans without
   disabling the rest of D1. Return 503, never continue with an empty budget.
5. Warning changes at exactly 15M. UTC month rollover does not clear history.
   Multi-day budget expiration and resume time agree with observed admission.
6. Ten serial full manual scans succeed; the eleventh and legacy request are
   denied. Expire only the fixture cooldown between starts to avoid a 50-minute
   wait. Separately verify real five-minute cooldown and UTC daily reset.
7. Full scan steps are serial, repeated steps do not re-fetch, and manual limits
   do not stop automatic checks. All requests still consume reservations.
8. Scheduled failures advance rotation. Recovery never fetches a source twice
   in the same hour. Inspect persisted in-progress state before adapter return.
9. Test 65,536-byte bodies at the boundary, one byte over, UTF-8, absent and
   dishonest Content-Length. Rejections must precede source work.
10. Run oversized streamed responses through each configured adapter family;
    preserve saved jobs, last success, and availability. No partial success.
11. Exercise concurrent Greenhouse detail responses whose combined size exceeds
    20 MiB, although each response individually fits.

## Production evidence (read-only and separately reported)

- Ask Cloudflare for the current traffic deployment and that version's runtime
  limit, rather than inferring deployment from `wrangler.json`.
- Query D1 tracking migration, reservations, source health, and recent results.
- Verify unauthenticated root/API routes redirect specifically to Cloudflare
  Access; a generic 302 alone is insufficient evidence of authentication.
- Observe scheduled events if available. State sample size and observation
  window; do not infer a CPU percentile or full-round success from one event.

## Conclusions that this audit cannot establish

Local emulation does not enforce Cloudflare's CPU ceiling. No intentionally
CPU-exhausting production request is authorized by this test plan. The audit
cannot establish exact runtime cutoff behavior, every future feed's performance,
account-wide billed CPU, a guaranteed $5 bill, or alert configuration without
additional corresponding evidence. A request reservation is not measured CPU.
Any synthetic interrupted-run state tests recovery logic, not an actual runtime
termination. Source imports tested locally are not proof that the production
bundle is byte-for-byte identical; deployed metadata is independent evidence.
