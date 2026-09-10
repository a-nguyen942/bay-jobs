# Bay Jobs

A small personal inbox for computer science jobs around San Francisco, San Jose, and the wider Bay Area. The intended loop is **check sources → save new matches → notify you → track your applications**. You apply on the employer's website yourself.

This is a local, runnable foundation. Figma’s public Greenhouse board is connected. Email notifications are implemented and opt-in; configure the provider before enabling them. Around-the-clock hosting still needs to be connected. No AI, resume generation, automatic applications, paid API keys, or cloud account are required to run it locally.

## Run locally

Use Node.js 24 or newer and npm. On macOS/Linux:

```sh
npm ci
npm run db:migrate
npm run demo       # optional fictional sample listings
npm run dev
```

Open the URL printed by Vite (normally http://127.0.0.1:5173). The local Cloudflare runtime stores data in `.wrangler/state/`; status changes survive restarts. No Cloudflare login is needed. Keep that directory to preserve your inbox.

If you used the previous React/Vinext skeleton, run `npm install` to remove its old dependencies. The database ID, storage path, and original SQL migration are unchanged: your saved listings and application statuses carry over without a reset.

Click **Check for new jobs** to fetch Figma’s current postings and save matching Bay Area roles. **Refresh inbox** only reloads saved data. Repeating a source check updates existing records without adding duplicates. The initial import is a baseline: “new” means newly discovered by this app, not necessarily newly posted by the employer. Notifications start off; configure email and enable it in the monitor bar’s Settings panel.

Run `npm run db:migrate` after pulling schema changes; the migrations add the shared check lock, inbox indexes, and notification tables without changing saved jobs.

`npm run demo` is repeatable and preserves edits to existing demo records. `npm run demo:clear` removes only fictional listings. Both target the **local** database.

## The lighter stack

- **Browser:** HTML, plain CSS, and JavaScript (ES modules). No frontend framework, client router, CSS framework, or server-rendered component system.
- **Backend:** one Cloudflare Worker using standard `Request`/`Response` handlers for the jobs API and a scheduled handler for monitoring.
- **Storage:** D1 with prepared SQL and checked-in SQL migrations. No ORM or schema-generation dependency.
- **Tools:** Vite, the Cloudflare Vite plugin, Wrangler, and Node's built-in test runner. The small Sites plugin preserves existing hosting metadata for later use.

There are no application runtime npm dependencies. Development still uses Cloudflare's runtime emulator through Wrangler; this is a small hosted-worker architecture, not a single standalone script.

```text
index.html              Static inbox layout and metadata
web/main.js             DOM rendering, filters, and UI events
web/inbox.js            API calls, pending writes, and refresh coordination
web/styles.css          Plain responsive CSS
worker/index.js         API routing, static assets, and scheduled entry point
worker/api.js           Inbox/status endpoints and manual source checks
worker/check.js         Shared manual/cron check with a D1 lease
worker/monitor.js       Fetch → filter → deduplicate → persist
worker/sources/         Source adapters and live Greenhouse implementation
worker/notifications.js Durable email staging, delivery, and retries
worker/notification-api.js Notification settings, history, and retry endpoints
web/notifications.js    Inline notification settings and delivery status
config/                 Explicit source list and search preferences
db/jobs.js              Prepared SQL queries
drizzle/                SQL migrations (legacy directory name retained)
fixtures/demo.sql       Optional fictional jobs
lib/                    Shared constants, matching, and URL normalization
tests/                  Database/API and inbox coordination tests
```

The browser reads the API on load, every minute while visible, and when you return to the tab. The worker has a separate 30-minute cron configuration. The browser does not perform source collection, so future hosted checks and notifications can continue while the inbox is closed.

## Working now

- Server-side search across all saved jobs, 50-job pages, and job details.
- Unseen/applied/archived tabs plus a small menu for considering/interviewing/rejected views. Result totals reflect the selected filter; the unseen count covers the whole inbox.
- Changing search or view returns to page one. Status changes refill the current page and recover automatically when the last page disappears. Click a listing to expand its details directly beneath that row; click again to collapse it. An expanded job stays in place if marking it seen or changing its status removes it from the current filter, until you close it or navigate away.
- Separate seen/unseen and application status. Opening a job marks it seen; opening the employer link does not mark it applied.
- Persistent status changes and source health/error records.
- Figma’s public Greenhouse board with a manual check button, California-qualified Bay Area matching, technical-role filters, and conservative URL deduplication.
- Manual and cron checks share an expiring D1 lease. Double clicks are disabled; another active check returns a retryable conflict. Source failures appear separately from successful imports.
- Imports preserve user state. A job disappearing from a feed never deletes the saved application.
- The first successful import establishes a quiet notification baseline. Later newly inserted jobs are queued atomically with the job when email is enabled. Existing jobs and demo fixtures do not generate alerts.
- Opt-in Resend email delivery after checks or as a daily digest, with durable messages, bounded retries, and recent delivery history in the inbox.
- Per-job pending writes and stale-refresh protection.

## Next milestones

1. **Run around the clock:** configure owner-only access, a real hosted D1 database, migrations, and the deployed cron. Verify the selected sources fit hosting limits.
2. **Expand source coverage:** add selected company boards and a GitHub adapter for a chosen repository format.

`config/sources.js` enables Figma (`boardToken: 'figma'`). Edit this explicit list to change coverage. No credentials are required for the public Greenhouse Job Board API; email delivery has separate provider credentials. LinkedIn and Handshake should use user-authorized email imports or manual links; scraping is not included. See `worker/sources/README.md`.

Nothing has been deployed or provisioned. Local development does not trigger cron automatically and cannot monitor while your computer is asleep. `wrangler.json` contains a local placeholder database ID. `.openai/hosting.json` retains the logical D1 binding for future Sites hosting. No subscription is created by these files.

The local server binds to loopback and writes require a matching Origin header. Before exposing the app online, gate the entire inbox/API with owner-only authentication. An Origin check or hidden URL is not authentication.

## Email notifications

Open **Settings** beside the monitor bar. Enter your email, choose **After each source check** or **Daily digest**, enable alerts, and save. Provider configuration is required to enable delivery. Saving disabled settings is allowed before setup. No separate notification page or new npm dependencies are needed.

Local setup:

1. Create a Resend API key in your own Resend account. Use an authorized sender address. For personal testing, Resend’s test sender is restricted to your account’s email; sending to other addresses requires a verified domain. See [Resend sender restrictions](https://resend.com/docs/api-reference/errors).
2. Copy `.dev.vars.example` to `.dev.vars`. Set `RESEND_API_KEY` and `EMAIL_FROM` (a bare sender email address). Keep the file private; it is gitignored. Never put secrets in a `VITE_` variable or in browser code.
3. Run `npm run db:migrate`, restart `npm run dev`, and enable email in Settings. Enter your recipient address in the app, not in source code. For hosted use, configure the same variables as runtime secrets.

No real email is sent by the test suite. An API key and sender configuration have not been provisioned by this project. Provider quotas and any costs belong to your provider account; this app does not create a subscription.

**When email sends:** every manual or scheduled source check also processes due notifications. After-check mode groups up to 50 new jobs per email. Daily mode collects jobs until 24 hours after enablement (or the last due digest pass), then stages a digest at the first check on or after that time. The daily schedule uses elapsed time, not a fixed local wall-clock hour. Empty digests are not sent. Local mode still needs manual checks; closing the browser or sleeping your computer does not run a background email service. Deployment is required for the configured cron to run unattended.

**No backlog flood:** the first successful import for each source never queues alerts, including a recovered first import after an upstream failure. Jobs discovered while email is disabled are not queued later. Disablement or an address change cancels unsent work; re-enabling does not replay it. An email already accepted by the provider cannot be recalled.

**Reliable delivery:** jobs and their notification events commit together. Events have a unique job ID; staged emails contain a frozen recipient, sender, subject, and text body. Retries reuse the message ID as a Resend idempotency key and reuse the exact body even if a job title or sender configuration changes. Staging and provider acceptance are persisted separately, and one expiring database lease serializes delivery and settings changes. Each pass stages at most 500 events in messages of 50 and sends at most five emails; remaining work continues on later checks.

Transient failures retry after at least 1 minute, 5 minutes, 30 minutes, and 2 hours, when another check runs. After five failed attempts, the email is marked failed. Permanent provider errors fail immediately. Use **Retry failed emails** after resolving the issue. Recent history shows pending, sending, accepted, failed, uncertain, and cancelled states. “Accepted by provider” is not a delivery-to-inbox confirmation; bounce/delivery webhooks are not implemented.

[Resend’s idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) expire after 24 hours. The app stops retrying 23 hours after the first attempt and marks unresolved work uncertain; it never automatically resends it with a fresh ID. Check your provider’s history for those messages. Settings changes cannot proceed while a delivery pass holds the lease. These safeguards reduce duplicates; they are not a guarantee of exactly-once delivery across every provider or infrastructure failure.

## API and verification

- `GET /api/jobs?view=all&q=&page=1`: 50 jobs per page, filtered across the full database. Returns `jobs`, `pagination` (`page`, `pageSize`, `total`, `pages`), global `summary` (`total`, `unseen`, `demo`), and source health. `all` means the inbox excluding archived jobs; `new` means unseen and not archived. Every application status is also a valid view.
- Search matches a literal substring of title/company/location, using SQLite’s ASCII case folding; `%`, `_`, and quotes are ordinary text. Query length is limited to 200 characters. Pages are positive integers up to 1,000,000. Invalid values return 400.
- Pages sort by discovery time descending, then job ID ascending. Out-of-range pages return no jobs and accurate totals; the browser retries the last valid page. Pagination uses offsets, so rows can shift between pages as sources import or statuses change; it is not a frozen snapshot of the inbox.
- `POST /api/check`: checks configured boards and returns per-source `{ sourceId, inserted, matched, error }` results. Requires a matching Origin header; returns 409 when another check holds the lease. A 200 can include source errors, which the UI reports.
- `PATCH /api/jobs/:id`: `{ "seen": true }` and/or `{ "applicationStatus": "applied" }`; requires a matching Origin header.
- `GET /api/notifications`: saved settings, provider readiness (a boolean), queue counts, and the ten most recent deliveries. Secrets and email bodies are never returned.
- `PATCH /api/notifications`: `{ "enabled": false, "recipient": "you@example.com", "cadence": "each_check" }`; cadence can also be `daily`. Requires a matching Origin header.
- `POST /api/notifications/retry`: retry eligible failed emails using their original email IDs; requires a matching Origin header.
- Application states: `considering`, `applied`, `interviewing`, `rejected`, `archived`.

```sh
npm run check      # JavaScript syntax checks + behavior tests
npm run build      # static browser files + Cloudflare Worker bundle
npm start          # preview the production build locally
```

Database/API tests use Wrangler's `getPlatformProxy` with `persist: false` and remote bindings disabled. They execute real D1 queries against temporary storage, never your saved inbox, and use fake source feeds. Adapter and matching tests cover malformed feeds, ambiguous locations, unrelated roles, and URL identity. Inbox tests use controlled responses to exercise concurrent writes, manual checks, failed saves, and stale refreshes. Pagination tests seed 605 isolated records, walk every page, locate older applications through every status view, and verify literal search and invalid-input handling. Notification tests use a simulated sender and cover quiet baselines, atomic queue insertion, grouped digests, retries, interrupted sends, cancellation, settings validation, and provider idempotency headers. The emulator needs permission to bind local ports.

All application code, tests, and the Vite configuration use plain `.js` files with `import`/`export`. `npm run check` checks JavaScript syntax and runs the behavior tests; `npm run build` validates browser and worker bundling. There is no TypeScript compilation or static type-checking step.

For schema changes, add a new numbered `.sql` migration in `drizzle/` and run `npm run db:migrate`. Do not edit or rename an already-applied migration. The existing migration and historical Drizzle metadata are retained for compatibility; no Drizzle package is required.

## Matching boundaries

All experience levels are included, including internships and engineering management. Remote-only roles are excluded by default. A city must appear next to `CA` or `California`; city-only labels are deliberately skipped, even “San Francisco.” Multi-location roles qualify if one listed location matches. Known conflicting foreign-country qualifiers are rejected. This is a conservative text filter, not a geocoder or a full interpretation of workplace eligibility. Adjust `config/search.js` as preferences and source formats become clearer.

Role matching requires a technical function such as software engineering, frontend/backend development, data engineering, ML, security, or reliability engineering. Sales, recruiting, marketing, developer relations, and product management titles are excluded. Title-only matching can still miss unusual titles or misclassify mixed responsibilities.

URL normalization removes `utm_*` query parameters. For Greenhouse, it also merges known board-domain aliases, strips `gh_src`, section anchors on numeric job pages, and redundant `gh_jid` values that agree with the path. Other hosts retain fragments, trailing slashes, query ordering, and ambiguous parameters such as `ref` and `source` to preserve potential job identifiers. Distinct URLs for one requisition can still yield duplicates.

The check lease lasts at least five minutes and expires after interrupted runs; it is not a durable queue or an unlimited-run concurrency guarantee. Large feeds, lease renewal, source-provenance tracking, and more advanced import recovery remain follow-up work. Imports never remove previously saved jobs just because matching rules changed.

References: [Cloudflare static assets with Vite](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/), [Wrangler API and isolated bindings](https://developers.cloudflare.com/workers/wrangler/api/), [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).
