# Bay Jobs

A small personal inbox for computer science jobs around San Francisco, San Jose, and the wider Bay Area. The intended loop is **check sources → save new matches → notify you → track your applications**. You apply on the employer's website yourself.

The app connects to 23 public sources, including company boards, GitHub job repositories, and public YC/Wellfound searches. Optional Google Jobs, LinkedIn indexed search, and Adzuna imports use separately configured API accounts. Email notifications are opt-in. Cloudflare hosting supports hourly monitoring while your laptop is off. No AI, resume generation, automatic applications, paid API keys, or cloud account are required to run it locally.

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

Click **Check all sources** to fetch the configured boards and repositories and save matching Bay Area roles. **Refresh inbox** only reloads saved data. Repeating a source check updates existing records without adding duplicates. The initial import is a baseline: “new” means newly discovered by this app, not necessarily newly posted by the employer. Notifications start off; configure email and enable it in the monitor bar’s Settings panel.

Run `npm run db:migrate` after pulling schema changes; the migrations add the shared check lock, inbox indexes, notification tables, preferences, availability tracking, and application notes without deleting saved jobs.

`npm run demo` is repeatable and preserves edits to existing demo records. `npm run demo:clear` removes only fictional listings. Both target the **local** database.

## The lighter stack

- **Browser:** HTML, plain CSS, and JavaScript (ES modules). No frontend framework, client router, CSS framework, or server-rendered component system.
- **Backend:** one Cloudflare Worker using standard `Request`/`Response` handlers for the jobs API and a scheduled handler for monitoring.
- **Storage:** D1 with prepared SQL and checked-in SQL migrations. No ORM or schema-generation dependency.
- **Tools:** Vite, the Cloudflare Vite plugin, Wrangler, and Node's built-in test runner. The small Sites plugin preserves existing hosting metadata for later use.

The only application runtime npm dependency is `entities`, used to decode HTML entities in imported text. Development uses Cloudflare's runtime emulator through Wrangler; this is a small hosted-worker architecture.

## Private configuration and publishing

This repository contains source code, synthetic test data, and blank credential examples. API keys belong in ignored `.dev.vars` files for development and Cloudflare secrets for hosting. Never add a `VITE_` prefix to a secret: that makes it available to browser code. Local database files, builds, scratch notes, and generated usage/production reports are ignored.

The shared `wrangler.json` uses a placeholder database ID. For your deployment, copy it to `wrangler.production.json` and enter your production D1 ID in that ignored file. Vite and `npm run cf -- <wrangler arguments>` automatically select that private file when it exists, preserving the configuration used by local development and builds. Use `npm run cf -- d1 migrations apply DB --remote` for hosted migrations. A fresh clone runs locally without production settings.

To deploy, run `npm run build`, then `npm run cf -- deploy`. Set provider credentials with commands such as `npm run cf -- secret put RESEND_API_KEY`; enter the value at the prompt. Gate the deployed site and every API route with Cloudflare Access before saving personal data. A public source repository does not make the deployed inbox public.

Run `npm run check:privacy` before publishing. It scans files and the current branch's history for known token formats, local secret values, private files, and personal email addresses, printing paths only when something needs review. Builds also check browser files for private values. These checks supplement reviewing the outgoing diff; they cannot detect every possible secret format. Use GitHub's privacy email for commit attribution. Push the intended branch explicitly; do not publish editor checkpoint or stash refs with `--mirror`.

```text
index.html              Static inbox layout and metadata
web/main.js             DOM rendering, filters, and UI events
web/inbox.js            API calls, pending writes, and refresh coordination
web/styles.css          Plain responsive CSS
worker/index.js         API routing, static assets, and scheduled entry point
worker/api.js           Inbox/status endpoints and manual source checks
worker/check.js         Shared manual/cron check with a D1 lease
worker/monitor.js       Fetch → filter → deduplicate → persist
worker/preferences.js   Stored search preferences and validation
worker/availability.js  Per-source presence and possible-closure tracking
web/preferences.js      Compact search preference controls
web/job-notes.js         Application notes, follow-up dates, and unsaved drafts
worker/sources/         Greenhouse, Ashby, Lever, and GitHub source adapters
worker/import-job.js    Explicit saves from LinkedIn, Handshake, or employer links
web/sources.js          Source health and the saved-link form
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

The browser reads the API on load, every minute while visible, and when you return to the tab. The hosted worker checks all 23 sources every hour, 24/7: regular checks run at minutes 0–22, recovery at 23–45, and coverage maintenance/alerts/watchdog at 46, checking at most one source per invocation to keep each invocation bounded. The browser does not perform source collection, so future hosted checks and notifications can continue while the inbox is closed.

Night mode is the default. Use the **Night mode** toggle in the top bar to switch to light mode; your choice is remembered in this browser.

## Working now

- Server-side search across all saved jobs, 50-job pages, and job details.
- Unseen/applied/archived tabs plus a small menu for considering/interviewing/rejected views. Result totals reflect the selected filter; the unseen count covers the whole inbox.
- Changing search or view returns to page one. Status changes refill the current page and recover automatically when the last page disappears. Click a listing to expand its details directly beneath that row; click again to collapse it. An expanded job stays in place if marking it seen or changing its status removes it from the current filter, until you close it or navigate away.
- Separate seen/unseen and application status. Opening a job marks it seen; opening the employer link does not mark it applied.
- Persistent status changes, application notes, follow-up dates, and source health/error records.
- Follow-ups view ordered by date, with due-today and overdue labels; archived jobs are excluded.
- Figma, Stripe, Cloudflare, and Databricks via Greenhouse; Notion and Ramp via Ashby; Zoox and Palantir via Lever; plus the three GitHub repositories listed below, with a manual check button, California-qualified Bay Area matching, technical-role filters, and conservative URL deduplication.
- A compact Sources & saved links section shows each configured source’s last check, match count, and failures.
- Explicit saves from LinkedIn, Handshake, or employer links, with separate seen and application status. These are manual saves, not automated collection from LinkedIn or Handshake.
- Manual and cron checks share an expiring D1 lease. Double clicks are disabled; another active check returns a retryable conflict. Source failures appear separately from successful imports.
- Imports preserve user state. A job disappearing from a feed never deletes the saved application.
- The first successful import establishes a quiet notification baseline. Later newly inserted jobs are queued atomically with the job when email is enabled. Existing jobs and demo fixtures do not generate alerts.
- Opt-in Resend email delivery after checks or as a daily digest, with durable messages, bounded retries, and recent delivery history in the inbox.
- Per-job pending writes and stale-refresh protection.

## Deployment verification

1. Configure owner-only access, hosted D1, migrations, and the cron. Verify scheduled outcomes and source health against hosting limits.
2. Configure email sender and recipient, use Send test email, and confirm receipt. Daily summaries include follow-up/deadline reminders and coverage.
3. Verify optional aggregator credentials and their free-plan terms before enabling imports. Handshake email-alert importing and account connections remain future work.

`config/sources.js` enables Figma, Stripe, Cloudflare, and Databricks (Greenhouse), Notion and Ramp (Ashby), Zoox and Palantir (Lever), plus:

- [SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships/tree/dev): visible, active Software/Software Engineering listings with the Summer 2027 term, from `.github/scripts/listings.json` on `dev`.
- [vanshb03/Summer2027-Internships](https://github.com/vanshb03/Summer2027-Internships/tree/dev): visible, active listings with `season: Summer`, matching the main README; the data does not provide a separate year field.
- [speedyapply/2027-SWE-College-Jobs](https://github.com/speedyapply/2027-SWE-College-Jobs): the US internship tables in `README.md` on `main`. Separate new-grad and international files are not enabled.

Edit the explicit source list to change coverage. No API keys or GitHub login are needed for these public feeds; email delivery has separate credentials. GitHub data is read from raw files, never executed or rendered as HTML. Parsers follow the selected repositories and report format failures; arbitrary repositories may need another parser. Closed/hidden structured records and visibly closed table rows are skipped. A previously saved job is retained if a repository removes it or marks it closed. Repository timestamps and relative ages are not treated as employer posting dates. See `worker/sources/README.md`.

Ashby imports listed jobs and includes secondary location labels. Lever imports every page (100 jobs per page, up to 20 pages); failures or repeated IDs reject the feed instead of silently saving a partial result. Both use a 15-second source deadline and require no API keys. Lever also supports `region: 'eu'` in a source configuration. Explicit remote-only flags respect `includeRemote`; hybrid Ashby jobs remain eligible even when their broader `isRemote` flag is true. Original posting dates remain unknown: Ashby supplies the last publication time, and Lever’s creation timestamp does not establish a publication date.

Open **Sources & saved links** below the monitor bar to see each source’s health or save a listing from LinkedIn, Handshake, or any employer. Paste its job link and enter the role, company, and location. Explicit saves bypass automatic matching, start as seen/considering, and never queue an email. Re-saving the same canonical URL preserves all existing details and status. LinkedIn job IDs and Handshake job IDs normalize tracking and institutional-link variants. A LinkedIn link and an employer link to the same role can still be separate records.

LinkedIn now supports optional automatic discovery through Google’s index via SerpApi, as described below. Handshake remains a **manual-link source**. LinkedIn [prohibits scraping automation](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions); Handshake offers [saved-search email alerts](https://support.joinhandshake.com/hc/en-us/articles/218693388-Saving-Job-Searches-and-Receiving-Job-Alerts). Email importing and account connections are not implemented.

Bay Jobs is deployed on Cloudflare Workers with a hosted D1 database and Cloudflare Access protection. The hosted hourly cron runs independently of your laptop. Local development does not trigger cron automatically. `.openai/hosting.json` retains the logical D1 binding.

The local server binds to loopback and writes require a matching Origin header. Before exposing the app online, gate the entire inbox/API with owner-only authentication. An Origin check or hidden URL is not authentication.

## Search preferences and availability

Open **Search preferences** below the monitor bar to choose Bay Area cities, remote inclusion, experience levels, and optional included/excluded title keywords. Select multiple cities using Command/Ctrl, or use Select all cities. Preferences persist in D1 and are shared by manual and scheduled checks. A running check uses the settings captured when it started; changes apply on the next check. All experience levels and Bay Area cities are selected by default, preserving previous behavior. Empty city selection is allowed only when remote inclusion is enabled.

Included title keywords use OR matching; excluded keywords reject any matching title. These are literal, case-insensitive substrings, not regular expressions. The existing technical-role exclusions and California-qualified location matching remain in effect. Experience is estimated from titles: internships/co-ops, explicit new-grad/junior/entry-level/Engineer I, explicit experienced titles, or unspecified. This is not a qualification assessment; generic Software Engineer titles are unspecified. Keep that option selected to avoid excluding ambiguous roles. Company feeds and the enabled repository sections remain the same.

Settings affect new discoveries, not saved applications. Narrowing filters neither deletes saved jobs nor marks them closed. Broadening filters can discover older listings and queue notifications if email is enabled. Manual link saves still bypass discovery filters.

**Possibly closed** appears on a row and inside its expanded details after a job is absent from every previously observed source for at least two successful checks per source. Failures do not advance this count. Presence is checked against the full adapter feed before user search preferences are applied. A reappearance clears the flag, even if the role no longer matches your preferences. Availability updates and the source success record commit together. Application status, seen state, and saved links are preserved; the application link remains usable.

This is an availability estimate, not confirmation that the employer closed the role. Repository removals, upstream filtering, or changed URLs can also cause absence. Disabled or persistently failing sources retain their last evidence and can delay a flag. Existing imported jobs establish tracking on their next successful source check using their original source label or URL. Demo jobs and manual links have no availability evidence unless subsequently observed in a monitored feed. No closure emails are sent, and reappearance of an existing job does not generate a new-job alert.

Run `npm run db:migrate` to apply `0004_preferences_availability.sql` after updating an older checkout. It adds stored preferences, per-source presence history, and a nullable closure timestamp without deleting jobs.

## Application notes and follow-ups

Expand a listing to edit its notes and follow-up date, then click **Save notes**. Notes support up to 10,000 characters. Clear the date to remove a follow-up. Unsaved drafts remain while you browse listings in the same page, but are lost on reload or closing the page. Saved notes and dates survive source updates and application status changes.

The **Follow-ups** tab lists scheduled, non-archived applications with the earliest date first. Rows label dates as due today or overdue using your browser's local date. Optional daily email summaries include overdue and upcoming reminders using Pacific dates. Apply `0005_application_notes.sql` with `npm run db:migrate` when updating an existing checkout.

## Email notifications

Open **Settings** beside the monitor bar. Enter your email, choose **After each source check** or **Daily digest**, enable alerts, and save. Provider configuration is required to enable delivery. Saving disabled settings is allowed before setup. No separate notification page or new npm dependencies are needed.

Local setup:

1. Create a Resend API key in your own Resend account. Use an authorized sender address. For personal testing, Resend’s test sender is restricted to your account’s email; sending to other addresses requires a verified domain. See [Resend sender restrictions](https://resend.com/docs/api-reference/errors).
2. Copy `.dev.vars.example` to `.dev.vars`. Set `RESEND_API_KEY` and `EMAIL_FROM` (a bare sender email address). Keep the file private; it is gitignored. Never put secrets in a `VITE_` variable or in browser code.
3. Run `npm run db:migrate`, restart `npm run dev`, and enable email in Settings. Enter your recipient address in the app, not in source code. For hosted use, configure the same variables as runtime secrets.
4. Click **Send test email** and confirm receipt in your inbox. Test messages use the same durable delivery and retry system, even in daily mode. Repeated clicks within a minute reuse the same message. Delivery history labels these as Test email. The button can also process other due notifications.

No real email is sent by the test suite. An API key and sender configuration have not been provisioned by this project. Provider quotas and any costs belong to your provider account; this app does not create a subscription.

**When email sends:** every manual or scheduled source check also processes due notifications. After-check mode groups up to 50 new jobs per email. Daily mode collects jobs until 24 hours after enablement (or the last due digest pass), then stages a digest at the first check on or after that time. The daily schedule uses elapsed time, not a fixed local wall-clock hour. Empty digests are not sent. Local mode still needs manual checks; closing the browser or sleeping your computer does not run a background email service. Deployment is required for the configured cron to run unattended.

**No backlog flood:** the first successful import for each source never queues alerts, including a recovered first import after an upstream failure. Jobs discovered while email is disabled are not queued later. Disablement or an address change cancels unsent work; re-enabling does not replay it. An email already accepted by the provider cannot be recalled.

**Reliable delivery:** jobs and their notification events commit together. Events have a unique job ID; staged emails contain a frozen recipient, sender, subject, and text body. Retries reuse the message ID as a Resend idempotency key and reuse the exact body even if a job title or sender configuration changes. Staging and provider acceptance are persisted separately, and one expiring database lease serializes delivery and settings changes. Each pass stages at most 50 events into one message and sends at most one email; remaining work continues on later checks.

Transient failures retry after at least 1 minute, 5 minutes, 30 minutes, and 2 hours, when another check runs. After five failed attempts, the email is marked failed. Permanent provider errors fail immediately. Use **Retry failed emails** after resolving the issue. Recent history shows pending, sending, accepted, failed, uncertain, and cancelled states. “Accepted by provider” is not a delivery-to-inbox confirmation; bounce/delivery webhooks are not implemented.

[Resend’s idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys) expire after 24 hours. The app stops retrying 23 hours after the first attempt and marks unresolved work uncertain; it never automatically resends it with a fresh ID. Check your provider’s history for those messages. Settings changes cannot proceed while a delivery pass holds the lease. These safeguards reduce duplicates; they are not a guarantee of exactly-once delivery across every provider or infrastructure failure.

## API and verification

- `GET /api/preferences`: saved preferences and available city/experience choices.
- `PATCH /api/preferences`: all five fields `{ locations, includeRemote, experienceLevels, keywords, excludedKeywords }`; matching Origin required. Keywords are limited to 20 entries of 80 characters per list.
- `GET /api/jobs?view=all&q=&page=1`: 50 jobs per page, filtered across the full database. Returns `jobs`, `pagination` (`page`, `pageSize`, `total`, `pages`), global `summary` (`total`, `unseen`, `demo`), and source health (configured sources only, including per-source last attempt, last success, last successful match count, and error). `all` means the inbox excluding archived jobs; `new` means unseen and not archived. Every application status is also a valid view. `follow_up` includes non-archived jobs with a follow-up date and sorts by that date first.
- Search matches a literal substring of title/company/location, using SQLite’s ASCII case folding; `%`, `_`, and quotes are ordinary text. Query length is limited to 200 characters. Pages are positive integers up to 1,000,000. Invalid values return 400.
- Pages sort by discovery time descending, then job ID ascending (the Follow-ups view sorts by follow-up date first). Out-of-range pages return no jobs and accurate totals; the browser retries the last valid page. Pagination uses offsets, so rows can shift between pages as sources import or statuses change; it is not a frozen snapshot of the inbox.
- `POST /api/check`: checks configured boards and returns per-source `{ sourceId, inserted, matched, error }` results. Requires a matching Origin header; returns 409 when another check holds the lease. A 200 can include source errors, which the UI reports.
- `POST /api/jobs/import`: `{ "url": "https://…", "title": "Software Engineer", "company": "Example", "location": "San Jose, CA" }`; requires a matching Origin header. Returns `{ job, created }`, with status 201 for a new save or 200 for an existing listing.
- `PATCH /api/jobs/:id`: `{ "seen": true, "applicationStatus": "applied", "notes": "Contact recruiter", "followUpDate": "2027-02-15" }`; any subset is accepted. Notes must be a string of at most 10,000 characters. Follow-up dates must be real `YYYY-MM-DD` dates, or `null` to clear. Requires a matching Origin header.
- `GET /api/notifications`: saved settings, provider readiness (a boolean), queue counts, and the ten most recent deliveries. Secrets and email bodies are never returned.
- `PATCH /api/notifications`: `{ "enabled": false, "recipient": "you@example.com", "cadence": "each_check" }`; cadence can also be `daily`. Requires a matching Origin header.
- `POST /api/notifications/test`: queue a test to the saved recipient and process due deliveries; requires configured, enabled email and a matching Origin header.
- `POST /api/notifications/retry`: retry eligible failed emails using their original email IDs; requires a matching Origin header.
- Application states: `considering`, `applied`, `interviewing`, `rejected`, `archived`.

```sh
npm run check      # JavaScript syntax checks + behavior tests
npm run build      # static browser files + Cloudflare Worker bundle
npm start          # preview the production build locally
```

Database/API tests use Wrangler's `getPlatformProxy` with `persist: false` and remote bindings disabled. They execute real D1 queries against temporary storage, never your saved inbox, and use fake source feeds. Adapter and matching tests cover GitHub season/category/visibility filters, both SpeedyApply table layouts, Ashby visibility and secondary locations, Lever pagination and partial-fetch failures, remote/hybrid flags, source routing, malformed feeds, ambiguous locations, unrelated roles, and URL identity. Inbox tests use controlled responses to exercise concurrent writes, manual checks, failed saves, and stale refreshes. Pagination tests seed 605 isolated records, walk every page, locate older applications through every status view, and verify literal search and invalid-input handling. Notification tests use a simulated sender and cover quiet baselines, atomic queue insertion, grouped digests, retries, interrupted sends, cancellation, settings validation, and provider idempotency headers. Manual-import tests cover input/origin validation, duplicate saves, and state preservation. Preference and availability tests cover persistent settings, validation, title classification, filtered-out saved jobs, consecutive successful misses, source failures, multiple sources, reappearance, and transaction rollback. Notes tests cover validation, preservation across imports/status/closure changes, clearing fields, and follow-up ordering before pagination. Test-email tests verify setup checks, origin checks, durable delivery, and repeated-click deduplication. The emulator needs permission to bind local ports.

All application code, tests, and the Vite configuration use plain `.js` files with `import`/`export`. `npm run check` checks JavaScript syntax and runs the behavior tests; `npm run build` validates browser and worker bundling. There is no TypeScript compilation or static type-checking step.

For schema changes, add a new numbered `.sql` migration in `drizzle/` and run `npm run db:migrate`. Do not edit or rename an already-applied migration. The existing migration and historical Drizzle metadata are retained for compatibility; no Drizzle package is required.

## Matching boundaries

All experience levels are included by default, including internships and engineering management. Change them in Search preferences. Remote-only roles are excluded by default. A configured board with zero matches can still be healthy. A city must appear next to `CA` or `California`; city-only labels are deliberately skipped, even “San Francisco.” Multi-location roles qualify if one listed location matches. Known conflicting foreign-country qualifiers are rejected. This is a conservative text filter, not a geocoder or a full interpretation of workplace eligibility. Some boards use city-only labels, and some repository tables abbreviate additional locations as `+N`; those hidden locations are not inferred. Use Search preferences for personal filtering; `config/search.js` defines the available Bay Area cities and base technical-role patterns.

Role matching requires a technical function such as software engineering, frontend/backend development, data engineering, ML, security, or reliability engineering. Sales, recruiting, marketing, developer relations, and product management titles are excluded. Title-only matching can still miss unusual titles or misclassify mixed responsibilities.

URL normalization removes `utm_*` query parameters. For Greenhouse, it also merges known board-domain aliases, strips `gh_src`, section anchors on numeric job pages, and redundant `gh_jid` values that agree with the path. Other hosts retain fragments, trailing slashes, query ordering, and ambiguous parameters such as `ref` and `source` to preserve potential job identifiers. Distinct URLs for one requisition can still yield duplicates.

The check lease lasts at least five minutes and expires after interrupted runs; it is not a durable queue or an unlimited-run concurrency guarantee. Large feeds, lease renewal, source-provenance tracking, and more advanced import recovery remain follow-up work. Imports never remove previously saved jobs just because matching rules changed.

References: [Cloudflare static assets with Vite](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/), [Wrangler API and isolated bindings](https://developers.cloudflare.com/workers/wrangler/api/), [Greenhouse Job Board API](https://docs.greenhouse.io/job-board.html), [Ashby public postings](https://developers.ashbyhq.com/docs/public-job-posting-api), [Lever public postings](https://github.com/lever/postings-api), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).


## Free-tier safeguards and usage measurement

Migration `0006_usage_guards.sql` adds persistent email attempt budgets and a five-minute manual-check cooldown. Run `npm run db:migrate` before starting an updated checkout.

- Email sends reserve allowance atomically **before** contacting Resend: at most **100 attempts in a rolling 24 hours** and **3,000 in a rolling 31 days**. These conservative windows cover Resend's published 100/day and 3,000/month free allowance without assuming its reset date. Tests, retries, failed requests, and interrupted sends all consume allowance. Unattempted emails remain pending when capped, and a later notification pass resumes them once allowance is available. Already attempted emails still obey the existing 23-hour uncertainty cutoff. Settings changes never reset the budget. On migration, known recent historical attempts are conservatively charged at migration time because individual retry timestamps were not previously recorded.
- Notification Settings shows both budgets and the earliest possible resume time. This counts **this database's attempts**, not your entire Resend account. Other apps, another local/hosted database, and inbound emails can consume the same provider quota. Keep the provider account on Free; this app cannot enforce account billing settings. See [Resend quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits).
- Manual checks reserve a five-minute cooldown after obtaining the shared check lock, even if source fetches fail. A blocked request returns HTTP 429 with `Retry-After`, and the inbox displays the wait message. The allowance is shared across tabs and survives restarts. Cron bypasses the manual cooldown but still shares the existing concurrency lock. Rejected requests still use a small amount of database work; this is not an account-wide database usage cap.

Run `npm run measure:usage` to capture the configured public feeds and replay baseline, full-repeat, and conditional-repeat imports in an isolated, temporary D1 database using default search preferences. It also measures disabled, idle, and sending notification passes using a fake sender. The report includes response bytes, simulated HTTP 304 counts, Node process CPU, SQL statements, and local D1 rows read/written. It does not modify your saved inbox or send real email. Source failures are explicitly reported and excluded. Captured ETags simulate unchanged responses; the benchmark does not prove that an upstream server will honor validators. Optional `--snapshot=/absolute/path/public-feeds.json` and `--output=/absolute/path/report.json` arguments to `node scripts/measure-usage.js` allow repeating a captured workload. Snapshots map public URLs to `{ status, headers, body }`, where `body` is base64-encoded response bytes; snapshot contents are decoded outside measurement.

**CPU interpretation:** Node process CPU includes proxy/runtime overhead and excludes emulator subprocess CPU. It is not Cloudflare Worker CPU and must not be compared directly with the hosted 10 ms limit. Verify real invocation CPU in Cloudflare metrics after a controlled deployment before enabling unattended scheduling. Local row counts are diagnostic estimates, not a provider bill or guaranteed future workload.

The September 14, 2026 UTC sample fetched all 11 sources. Baseline: 1,425 SQL statements, 11,325 rows read, 4,862 written, 2,032.551 ms Node process CPU for import. Repeat: 1,425 statements, 13,765 rows read, 1,405 written, 1,927.531 ms Node CPU. At 48 unchanged scheduled checks/day, repeat usage projects to 660,720 reads and 67,440 writes, excluding manual checks, notifications, and inbox traffic. Maximal manual use can exceed daily free allowances. The full-check query volume also needs reducing/splitting before free deployment; see [D1 invocation limits](https://developers.cloudflare.com/d1/platform/limits/). No free-tier compatibility or uninterrupted operation is certified by this measurement.


## Monitor optimization and deployment status

Scheduled checks select the least recently attempted source, with configuration order breaking ties. Manual **Check all sources** now starts a browser-driven sequence that checks every configured source once in separate requests; see the manual scan section below. Both paths share the source-check lock. A caught source failure does not stop subsequent sources.

Each source imports matches with three bulk JSON/SQL statements instead of three statements per listing. Job insertion and new-job email staging remain in the same transaction. Source-owned fields refresh immediately when changed; for unchanged jobs, `last_seen_at` refreshes once per UTC day to reduce writes. Source health records still show the exact successful check time, and presence/closure tracking still runs every successful check. Seen state, application status, notes, and follow-up dates are untouched. Redundant closure updates and already-capped missing counters no longer write unchanged rows.

Notification passes now stage at most 50 events and send at most one queued email, keeping the combined check/delivery invocation small. Larger backlogs continue on subsequent passes, subject to the existing rolling budgets and retry window.

The initial optimized comparison on the same 11 live feeds reduced full-cycle import SQL statements from 1,425 to 102 and unchanged-repeat writes from 1,405 to 632 (before additional per-invocation rotation/lock overhead). The latest `usage-report.json` measures a full cycle as separate rotating invocations and lists each invocation's import queries. It excludes email processing and browser requests. These are local measurements; they do not establish hosted CPU compatibility.

**Hourly scheduling:** `triggers.crons: ["0-46 * * * *"]` runs every hour, including overnight and weekends. Minutes :00–:22 check the least recently attempted source, one per invocation. Minutes :23–:45 recover failed or missing current-hour checks, with at most one extra attempt per source per hour; healthy sources are skipped. At :46, an incomplete scan queues one warning email for that hour when email and scan warnings are enabled. This schedules 1128 bounded invocations per day, with no source fetch in unused recovery slots. Each source still runs in a separate invocation; this does not guarantee compliance with the CPU allowance. Keep the minute range aligned with twice the source count; a regression test checks that relationship. Held leases, runtime failures, or delayed cron execution can postpone coverage. The browser and laptop can be off. Verify scheduled outcomes in Cloudflare Observability and source health in the app. Email caps and the shared check lock still apply.

### Conditional feeds and prepared matching rules

The monitor prepares city, role, and keyword matching rules once per check. Greenhouse, Ashby, and GitHub checks send `If-None-Match` after a successful full import. A `304 Not Modified` response skips body parsing and matching, while D1 reuses the saved URL snapshot to update source health, cross-source provenance, and missing-job counts. Lever continues to fetch every page normally.

Migration `0007_source_feed_cache.sql` adds the durable validator and URL snapshot. Apply it before running the updated Worker (`npm run db:migrate` locally; `npm run cf -- d1 migrations apply DB --remote` for your hosted database). It does not remove jobs or application history. A full import is forced after search preferences or source configuration change and once each UTC day to refresh last-seen dates. Validators are saved atomically with availability updates, only after successful parsing and job writes. When changing adapter/matching semantics, bump the cache revision in `worker/monitor.js`.

Conditional responses do not remove the CPU cost of processing a changed feed. In particular, Simplify's large JSON feed still needs hosted CPU verification. The local usage script replays response bodies and simulates conditional responses, so it exercises both full imports and the conditional path.


The latest follow-up removes a separate source-cache lookup and constructs matching rules only when a full response needs matching. Notification passes first check for due work: disabled/idle passes use one read and no writes, while real sends still acquire the existing lease and recheck settings. The preflight also preserves stale-lease recovery, expired retry handling, due daily digests, and old-budget cleanup. A pass with work pays one additional read for this preflight.

On the same captured 11-source workload, this follow-up reduced conditional-cycle statements from 125 to 116 and idle-email statements from 8 to 1 (writes from 2 to 0). One local comparison measured conditional-cycle Node CPU at 289 → 263 ms and idle-email CPU at 8.5 → 2.9 ms. These include local harness/proxy overhead and vary between runs; they are not per-source hosted CPU or a guarantee of free-tier headroom. Real sending still needs hosted measurement. That optimization did not change source coverage, UI, email cadence, or the hosting schedule. The subsequent hourly full-coverage schedule is described above.

### Skills and importance

The inbox can filter internships and match any or all selected skills: JavaScript/TypeScript, Python, C++, HTML, CSS, and common web frameworks. Importance orders internships first, then the count of selected skill groups mentioned, then discovery time. Sorting and filtering happen in D1 before pagination. These are inbox controls, not discovery or notification preferences.

Migration 0008 adds a compact skill mask. Tags are extracted on matching imports from titles and available Greenhouse, Ashby, and Lever descriptions; manual links use their title. GitHub feeds generally lack descriptions. Existing jobs gain tags on subsequent successful imports; a cache revision forces feeds to refresh. Description-bearing imports replace tags, while title-only imports preserve prior description tags. Mentions are approximate evidence, not proof of requirements or eligibility. No AI service or extra per-listing requests are used; Greenhouse requests content in its board response. This increases its response size, so actual hosted CPU usage still needs measurement against the free-plan limit.

### Favorites, deadlines, and source health

Migration 0009 adds favorites and a manually entered application deadline without changing existing application state. Open a job to star it, see selected skill matches, or save a deadline. Favorites and Deadlines views support existing inbox filters. Deadline sorting places missing dates last. The optional “Hide possibly closed listings” filter uses the existing two-successful-misses availability signal, not a confirmed employer closure. Match explanations compare selected skill groups with detected title/description mentions; they do not infer eligibility.

Source health flags the latest failed check, three or more consecutive failures, no successful check, or a success older than two hours. Recorded failures increment a counter; a successful check, including a cached feed, resets it. Warnings appear in the source section without extra network requests.

### Daily summaries and optional email skill filters

Email settings now offer a separately saved, optional any/all skill filter and internship restriction. These affect only future discoveries when the email skill filter is enabled. Existing queued email content is preserved, inbox browsing does not change email preferences, and reminders bypass skill filters. The new filter is off by default; the existing cadence is preserved.

Daily mode sends at most one newly composed summary per 24-hour interval at the next available source check, using the existing queue and attempt budget. It includes up to 50 new matches plus up to 20 overdue or next-seven-day follow-up/deadline reminders using Pacific calendar dates. Excess new matches remain queued for the next day. Archived/rejected/demo jobs are excluded from reminders; deadlines apply only to considering jobs. A reminder-only summary is allowed; daily mode includes coverage even without new matches or reminders. Clear a follow-up date when completed, and update application status after applying. The summary payload, attached events, and next due time commit together so retries reuse the same email ID/body. Existing provider failures or delayed retries can shift actual delivery timing. No additional paid services are introduced.

### Hourly scan completion summary

The inbox shows the current Pacific hour’s completed source checks, successes, failures, missing results, and newly discovered jobs. A scan is complete only when every configured source’s latest completed result in the hour is successful. Before :23, missing results are waiting; :23–:45 is the recovery window, and gaps remaining at :46 are marked incomplete. Failed sources are named separately. Automatic and manual source checks both count, once per source, and a successful retry replaces the failed outcome. This is a summary of the latest results, not a claim that a source is currently executing or a historical log of all attempts.

The summary uses existing source timestamps (recorded for the start of checks whose outcomes have been saved) and an indexed discovery-time query for jobs from currently configured source labels. Newly discovered automatic jobs count regardless of inbox filters/status; manual links, demos, and duplicates do not increase that count. The displayed hour and snapshot time make the freshness visible. It refreshes with the inbox and resets each hour, including across Pacific daylight-saving transitions. No new scheduled writes, migration, or paid service is required; the inbox adds one bounded database count query.

### Additional official internship boards

The September 2026 expansion adds six verified public employer boards: Roblox, Robinhood, Verkada, Scale AI, HP IQ, and DoorDash. Each new board is scoped to technical internship/co-op titles; existing saved location and experience preferences still apply. Existing sources keep their original scope.

These Greenhouse sources read the public job index without descriptions, then request only technical internship descriptions (up to 12 per check, two in parallel, one shared 15-second deadline). This avoids parsing every full-time description. The first/index response owns the saved ETag; detail requests never reuse its validator or overwrite it. A detail error, malformed response, or excessive internship count fails the whole snapshot rather than falsely marking omitted jobs closed. Cached source checks and the daily full refresh still apply.

Live adapter validation found 19 Bay Area technical internship listings across these six boards under the starting search preferences, including 14 with at least one supported skill mention. Counts are a research snapshot, not a promise of unique new jobs; existing repositories may already contain the same application URLs. Saved preferences and skill filters may reduce visible results further. First successful imports establish quiet email baselines. Regular scans run minutes :00–:22 each hour; recovery runs :23–:45, followed by an incomplete-scan warning check at :46. This reduces downloaded data for these boards but does not certify Cloudflare’s per-invocation CPU allowance.

See [source research](worker/sources/research.md) for official links and verification notes.

### One-click manual scans

**Check all sources** starts a persisted scan session, then the browser sends one request per source in configuration order. Each Worker invocation fetches only one source. The button displays progress, refreshes saved results between checks, continues past recorded source failures, and ends with a total of sources checked, new jobs and failures. Keep the tab open; page reloads, browser suspension or network failures can interrupt the sequence. Confirmed results remain saved.

Migration 0010 creates a singleton manual scan record with a token, source-ID snapshot, cursor, report and two-minute idle expiry. The five-minute cooldown is reserved once at scan start and cannot be bypassed by sending arbitrary continuation tokens. All steps use the existing check lock; scheduled source checks skip while an unexpired manual scan is active. A completed step can be requested again without refetching. A failed network response stops the browser sequence with a partial-progress message; the idle reservation expires so scheduled work can resume (an interrupted active invocation may hold the existing execution lease until it expires). No background completion after closing the tab is promised. Already-open older clients retain the former one-source POST behavior and share the cooldown.

Notification processing retains the existing per-source behavior and provider-attempt caps. Manual scans add usage proportional to the source count; separate invocations preserve individual allowances but do not certify that every source stays within the free CPU limit.

### Review and scan recovery

The **Needs review** tab shows saved, unarchived internships without detected skill tags. It bypasses skill filtering while retaining search and the hide-closed option. Once a later scan detects a skill, that listing leaves this section. It cannot surface listings excluded during collection or posted on sources the app does not monitor.

Recovery attempts are recorded before fetching so interrupted invocations cannot retry a source repeatedly in the same hour. Active manual scans temporarily block scheduled scans and recovery. A warning email names failed and missing sources after the recovery window; it is a snapshot, and later manual checks may resolve it. Warnings default on when email is enabled and can be disabled in Settings. They are separate from daily digests but share delivery retries and email limits. If the scheduler itself stops running, it cannot send a warning. Hourly polling also cannot guarantee capture of postings removed between scans.

### Coverage safety nets (September 16, 2026)

Migration 0012 adds `filtered_listings`, `source_integrity`, `source_checks`, and private watchdog settings.

- **Filtered-out internships:** stores internships rejected by discovery preferences, the first rejection reason, source, URL, skills and discovery timestamps. Retention is seven days after the last recorded observation (unchanged timestamps refresh once per UTC day to limit D1 writes); vanished candidates remain available until expiry. Successful unchanged responses refresh only candidates present in the committed source snapshot. The queue is paginated (25 rows), searchable, and offers Save to inbox. Promotion preserves existing application state, shares canonical URLs across sources and sends no discovery email. Candidates already saved are hidden. Adapter-level category/season limits still apply; uncollected roles cannot appear here.
- **Broader location review:** an optional saved preference includes US-wide, remote and unspecified locations in the review queue by default. It can also be toggled temporarily in that panel. This does not change normal location matching or claim that remote roles permit work from California.
- **Suspicious snapshots:** compare unique normalized URL counts with the prior accepted snapshot of the same source configuration, before applying filters. A drop from at least five listings to zero, or from at least twenty listings by 80% or more, holds the snapshot, reports a failed check and prevents absence/closure updates. Format validation and Greenhouse advertised-total validation also reject incomplete feeds. After verifying the employer board, the user can explicitly accept the next structurally valid snapshot once. Real seasonal closures can trigger this protection. Normal small decreases use the existing two-successful-misses rule.
- **Daily coverage:** eight days of completed check history, viewed by Pacific date (including DST boundaries), source successes/failures, automatic recovery successes, downloaded listing observations, filtered internship observations, new saved jobs, and current overdue sources. Download and filter counts include repeat observations and are not unique job counts. Source-cache hits are checks but not downloads. Daily email mode includes the previous Pacific day’s coverage even with no new matches; existing budgets apply. Runtime terminations cannot record completed outcomes and appear as missing coverage.
- **Overlapping discovery:** nineteen sources now include Asana and Airtable’s official public Greenhouse feeds plus the existing direct boards and three repositories. Both newly added boards returned valid responses with no internship titles on September 16. Their first imports establish quiet email baselines. LinkedIn/Handshake native alerts require the user’s account subscriptions; the app provides setup links and manual import, not unauthorized account access or inbox ingestion.
- **Independent watchdog:** connect a private Healthchecks.io ping URL in Backup discovery & independent watchdog. Create an external check with a one-hour period and thirty-minute grace, configure an email destination, and verify delivery there. At :46 the app sends a heartbeat only if every source’s latest current-hour result is successful. A missing heartbeat alerts from outside Cloudflare, including total scheduler outages. No URL means monitoring is **not active**. The UI reports connection status and last confirmed heartbeat but cannot certify the external alert destination. Disconnect locally only after pausing/deleting the external check.

Watchdog URLs accept only HTTPS `hc-ping.com/<UUID>` with no credentials, query, fragment or custom port. They are stored only in D1, never returned from the API or logged; outbound requests prohibit redirects and time out after five seconds. Only an empty heartbeat is sent, with no listings or recipient details. Connection controls require the same owner authentication and same-origin writes as the rest of the app.

Schedule: regular checks :00–:22, recovery :23–:45, maintenance/alerts/watchdog :46 each hour (1,128 invocations/day). Each regular or recovery invocation checks at most one source. Optional API aggregators run at maintenance when their separate 26-hour allowances are due. Extra history and review writes consume D1 quota; local usage measurements cannot certify hosted CPU usage.

References: [Healthchecks monitoring](https://healthchecks.io/docs/monitoring_cron_jobs/), [ping API](https://healthchecks.io/docs/http_api/), [plans](https://healthchecks.io/pricing/), [LinkedIn job alerts](https://www.linkedin.com/help/linkedin/answer/a508396), [Asana emerging talent](https://asana.com/jobs/university-recruiting), [Airtable careers](https://www.airtable.com/careers).

Local public-feed replay after this change: all 19 adapters succeeded. Same-day full repeats used 828 D1 rows written across the source rotation; simulated conditional repeats used 628, down from 3,326 and 3,136 before the unchanged-review write reduction. The initial empty-database import used 9,581 rows written. These are emulator measurements with starting preferences, not a billing or hosted CPU guarantee; recovery, maintenance, UI traffic, email processing and changed feeds add usage.

## Text normalization

Natural-language matching uses shared Unicode compatibility, case, accent, whitespace, common dash/quote, and invisible-format normalization. Imported HTML entities are decoded, and inline formatting does not split skill names. Display text keeps its capitalization. Inbox and review search use stored normalized search keys, including punctuation/spacing normalization; internship filters, Importance, review counts, and notification selection share a stored classification. API enum values accept case/whitespace variants; invalid types and unknown values still fail validation. URLs, IDs, credentials, protocol keys, email mailbox case, and free-form notes are not blindly lowercased.

Apply migration `0013_normalized_search.sql`, deploy, then run `node scripts/backfill-search.js --remote` (or `--local` for development) to update existing records. The bounded, repeatable backfill changes derived search/classification fields and adds title-derived skill tags, preserving saved text, URLs, discovery times, notes and application state. The import cache revision forces a fresh feed on the next scan so description tags and previously excluded candidates are re-evaluated. This handles tested formatting variants, not arbitrary malformed data or every language-specific equivalence.


### CPU safety controls

- Deployed Worker ceiling: `limits.cpu_ms = 500`. This applies to HTTP and scheduled invocations. Cloudflare enforces it only in production and allows occasional overruns; it is not an exact billing ceiling.
- Before each scheduled invocation or API mutation, atomically reserve 500 CPU-ms in D1. Failed, rejected and interrupted reserved attempts are never refunded. If accounting is unavailable, skip that work. Inbox reads remain available.
- Warn in the CPU safety panel at 15 million reserved CPU-ms; pause scheduled work and API changes before exceeding 21 million. Reservations expire after 31 days rounded up to UTC days (up to 32 days). No reset button bypasses this limit. Reads and rejected requests can still consume CPU while paused.
- Tracking starts with migration 0014; it does not reconstruct previous billing usage. This is a deliberately pessimistic **work reservation estimate**, not measured CPU, billing-cycle usage, or account-wide monitoring. Other Workers, reads, database usage, logs, prior usage and taxes remain outside it. Cloudflare billing/usage alerts still require account-level setup.
- Manual scans: five-minute cooldown, at most 10 starts per UTC day, one source at a time. Existing one-source manual requests share the same daily allowance. The hourly scan and one recovery attempt per source/hour remain unchanged. Existing scan leases prevent overlap.
- Source response bodies are limited to 20 MiB total per source invocation before parsing (including all Lever pages / Greenhouse details). A feed over 10,000 normalized listings is rejected before import. Oversized feeds fail visibly; they are never treated as a complete partial feed and do not close saved jobs. API mutation bodies are limited to 64 KiB.
- Persist source attempt time before fetching/parsing, so runtime termination leaves a visible unfinished attempt and advances rotation. A terminated invocation may still hold its existing lease until expiry.
- With 47 scheduled invocations/hour, 32 days reserve at most 18,048,000 CPU-ms before manual work. Actual CPU is typically lower. Pausing to preserve budget means new listings can be missed; the UI makes this explicit.

Apply migration `0014_cpu_safety.sql` before deploying this version. Keep `CPU_PER_INVOCATION_MS` and the Wrangler CPU ceiling equal; the regression test checks this. Do not increase either without reviewing the budget and source performance.


### Multi-company discovery

SimplifyJobs/New-Grad-Positions is now an automatic source alongside the three internship repositories. It reads active, visible software and AI/data listings; it does not apply an internship season constraint. Existing discovery preferences still determine what enters your inbox. Enable New grad / entry level roles to include new-grad jobs. The first successful import is a quiet baseline.

Optional Adzuna, Google Jobs, and LinkedIn indexed-search (via SerpApi) imports run at the hourly maintenance step, independently of the hourly employer-source rotation. Each configured search reserves **one request per 26 hours**, including errors and interrupted requests, in D1 before contacting the provider. This limits each search to at most 29 requests in any 31-day period: at most 58 SerpApi requests combined for Google Jobs and LinkedIn, plus 29 Adzuna requests. No automatic pagination or immediate retries occur. This is not an account-wide cap: other apps and databases using the same keys have separate usage.

Adzuna searches the newest 50 software listings around San Francisco with a distance parameter of 100 (then applies the saved Bay Area filters). Google Jobs searches one page for software engineering internships or new-grad roles in the Bay Area. These are partial discovery results, not exhaustive scans. Missing search results never increase closure counters. URLs deduplicate exactly as other sources do; aggregator redirects or alternate application links may still produce duplicates. Existing settings control notification delivery; the first successful provider import establishes a quiet baseline.

Setup (credentials are never entered in the browser):

1. Apply migration `0015_aggregator_budget.sql` with `npm run cf -- d1 migrations apply DB --remote` before deploying.
2. For Google Jobs and LinkedIn indexed search, create a **Free** account at https://serpapi.com/pricing. The published free plan checked September 28, 2026 offers 250 searches/month; confirm your account's current terms. Do not enable credit purchases or a paid plan. Set `SERPAPI_API_KEY` with `npm run cf -- secret put SERPAPI_API_KEY`.
3. For Adzuna, register at https://developer.adzuna.com/ and confirm that your intended personal use has ongoing free access. Their terms distinguish default API limits from trial/licensing requirements; a key alone does not establish ongoing free permission. Set `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` using `npm run cf -- secret put` for each. Leave these unset if ongoing free access is not confirmed.
4. Set `FREE_AGGREGATOR_IMPORTS` using `npm run cf -- secret put FREE_AGGREGATOR_IMPORTS`, entering `true`, only after confirming free-plan access for the providers whose keys you configured. A missing provider key leaves that provider disconnected. For local development, use the corresponding `.dev.vars.example` fields in your private `.dev.vars`.
5. Open **Backup discovery & independent watchdog → Multi-company discovery** to see connection status, last success/error, and the next eligible attempt. The next maintenance run performs a due import; credentials alone do not trigger a request. Due notification processing follows that run.

Wellfound and YC now run automatically from structured data embedded in their public pages. YC reads the public SF software-engineering listing page. Wellfound reads the first public SF and San Jose software-engineering search pages, including company names, locations and descriptions. These pages are samples: YC exposes a public selection, and Wellfound highlights jobs from the first page of companies. Additional pages, unlisted roles and signed-in results are not collected. Missing data, blocked responses, redirects or changed page formats report failures instead of empty successful imports. No login, cookies, API keys or browser automation are needed for these two sites.

The schedule is `0-46 * * * *`: 23 primary source slots, 23 recovery slots, then maintenance at :46. Optional daily API searches are outside the hourly completeness/watchdog count. The daily request cap cannot be bypassed by manual source checks, which do not include these optional providers.


### Automatic LinkedIn discovery

With `SERPAPI_API_KEY` on a Free account and `FREE_AGGREGATOR_IMPORTS=true`, the maintenance run also requests one page of Google organic results restricted to `linkedin.com/jobs/view`, software/data internships or new-grad roles, and SF/San Jose/Bay Area terms. The search requests recent results (`qdr:w`); that search filter is not a verified employer posting date. Title, company and location are parsed only from complete known search-title formats. Truncated or unrecognized results are skipped; if every candidate is unparseable, the source reports an error. Job URLs normalize by LinkedIn job ID and reuse manual-import identities.

This is **automatic indexed discovery**, not a full LinkedIn search or logged-in feed. Google may omit, delay or retain expired postings, and title/snippet data is less complete than employer feeds. The app never guesses a location from the query, opens a LinkedIn session, follows sign-in challenges, or stores LinkedIn cookies. New matching discoveries after the initial quiet baseline enter the regular email queue. The API status panel distinguishes missing credentials, waiting, failures and successful checks. Both SerpApi searches share the same key but have separate 26-hour reservations, keeping their combined usage below the published 250-search free allowance when this app is the only consumer. A real keyed response still needs verification after setup.
