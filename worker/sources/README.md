# Source adapters

Each adapter is a plain object with `id`, `label`, and an async `fetchListings()` method returning listing objects with `sourceJobId`, `title`, `company`, `location`, `url`, and `postedAt` (an employer posting date or `null`). Keep source parsing here; matching, deduplication, persistence, and notification queuing belong in the monitor. `createSources()` selects the adapter by `kind`.

## Connected feeds

- **Greenhouse:** Figma, Stripe, Cloudflare, and Databricks, plus internship-only boards for Roblox, Robinhood, Verkada, Scale AI, HP IQ, and DoorDash. Add/remove company entries in `config/sources.js`. Uses the public Job Board API, with a 15-second timeout and no key.
- **Ashby:** Notion and Ramp. Reads the public posting API, excludes `isListed: false`, and includes primary and secondary location labels. Uses `workplaceType` to distinguish remote-only roles from hybrid roles. The last publication timestamp is not treated as an original posting date.
- **Lever:** Zoox and Palantir. Reads public postings in pages of 100 with a 20-page bound. Uses all supplied location labels and remote-only workplace flags. A failure, repeated posting ID, or exhausted page limit fails the whole fetch before persistence. The complete paginated fetch has a 15-second deadline. Set `region: 'eu'` for European Lever boards; the default is global. Creation time is not treated as an employer posting date.
- **SimplifyJobs/Summer2027-Internships:** `.github/scripts/listings.json` on `dev`, with active/visible flags, a Summer 2027 term, and Software/Software Engineering category. This follows the software section selected by the user, then applies the shared job filters.
- **vanshb03/Summer2027-Internships:** `.github/scripts/listings.json` on `dev`, active/visible summer rows. Its `season` field has no separate year; source data may include older records. Off-season rows are excluded, matching its main README.
- **speedyapply/2027-SWE-College-Jobs:** US internship tables from `README.md` on `main`, with or without the salary column. Company text, role, visible location, and application link are read; repository HTML is never inserted into the UI. Separate new-grad/international files are not read.

GitHub requests use `raw.githubusercontent.com`, a 15-second timeout, and a 20 MB response limit. No GitHub key or authenticated account is required. These are repository-specific parsers, not a universal Markdown importer. Check a new repository’s format before adding it. Preserve source attribution; source labels identify the board or repository. No repository code or README assets are copied into the app.

Repository timestamps/relative ages are not employer posting dates, so `postedAt` stays null. Closed/hidden rows are skipped where the source exposes those flags. Missing/closed listings never delete saved applications. The monitor tracks presence before user preferences are applied and flags possible closure after two successful misses from every observed source. Reappearance clears the flag; adapter failures do not count as absence. Source feeds and matching may be incomplete or stale. URLs shared across feeds deduplicate, but different application URLs for the same role may remain separate jobs.

## Adding company boards

Use the company’s public board token in `config/sources.js`, for example:

```js
{ id: 'notion', kind: 'ashby', company: 'Notion', boardToken: 'notion' },
{ id: 'zoox', kind: 'lever', company: 'Zoox', boardToken: 'zoox' },
```

Keep IDs unique and stable: each ID owns its check history and quiet initial baseline. Public board tokens can differ from company names; verify the feed before enabling one. These adapters do not need credentials. The existing monitor handles filtering, URL deduplication, and notification events. `isRemoteOnly` is optional adapter metadata used during matching, not an additional database column. Location labels without a California qualifier remain subject to the existing conservative filter.

## LinkedIn and Handshake

Use **Sources & saved links** to explicitly save a listing URL, role, company, and location. `worker/import-job.js` stores the record without fetching the URL or accessing an account. LinkedIn and Handshake URL variants normalize by job ID. Explicit saves bypass discovery filters, start as seen, preserve existing records on duplicates, and never queue notifications.

LinkedIn indexed discovery is available through SerpApi; direct LinkedIn/Handshake scraping and alert-email imports are not implemented. LinkedIn prohibits scraping automation; Handshake supports saved-search email alerts. A future email import needs an explicit input workflow or authorized account connection.

Sources must throw on request or format failures instead of returning a misleading empty array. Failures appear per source without stopping the other sources. A successful first import establishes a quiet baseline; subsequent newly discovered matches enter the existing email queue only while notifications are enabled. No adapter submits applications.

References: [Ashby public postings](https://developers.ashbyhq.com/docs/public-job-posting-api), [Lever public postings](https://github.com/lever/postings-api), [Greenhouse API](https://docs.greenhouse.io/job-board.html), [SimplifyJobs source](https://github.com/SimplifyJobs/Summer2027-Internships/tree/dev), [Vansh source and license](https://github.com/vanshb03/Summer2027-Internships/tree/dev), [SpeedyApply source](https://github.com/speedyapply/2027-SWE-College-Jobs), [LinkedIn automation policy](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions), [Handshake saved-search alerts](https://support.joinhandshake.com/hc/en-us/articles/218693388-Saving-Job-Searches-and-Receiving-Job-Alerts).

For a Greenhouse board with `internshipsOnly: true`, the adapter reads the lightweight job index and fetches descriptions only for technical internship/co-op titles. It validates the entire index before selection and requires every selected detail request to succeed. At most 12 details are allowed, with two simultaneous requests and one 15-second timeout for the whole feed. The conditional cache belongs to the index; details are requested without that validator. Description changes that do not change the index validator are picked up by the existing daily full import. No per-job description caching is added. Scope is independent of saved city/experience preferences so changing those does not manufacture closure signals.


## Multi-company sources

`github-simplify-newgrad` reads SimplifyJobs/New-Grad-Positions on `dev`, using active/visible flags and software/AI/data categories without internship term checks. It participates in the normal hourly rotation.

`worker/aggregators.js` adds optional Adzuna, Google Jobs, and LinkedIn indexed-search imports. Enable only with confirmed free-plan credentials and `FREE_AGGREGATOR_IMPORTS=true`. Each provider reserves one request per 26 hours in `aggregator_budget` before fetching, including failures. Requests are first-page-only, bounded to 2 MB and 15 seconds, and do not follow redirects. Provider error bodies and keyed request URLs are never included in application errors. Imports run at maintenance and use the shared monitor lease. They reuse filtering, deduplication, a quiet initial baseline, and existing email settings.

These sources set `discoveryOnly: true`: ranked search results are incomplete samples, so omissions never increment missing counters and listing-count drops do not require snapshot acceptance. They are excluded from the hourly completeness/watchdog count; their separate status endpoint shows configuration, last success, errors, and the next eligible attempt. Wellfound and YC now have public-page adapters in `public-boards.js`, running hourly with `discoveryOnly: true`. See README setup and limitations.


`public-boards.js` parses YC Inertia `props.jobPostings` and Wellfound Next.js Apollo `StartupResult` → `highlightedJobListings` references. It validates selected page identity and required listing fields, bounds HTML to 2 MB, uses a 15-second timeout, and rejects redirects/challenges. Only the exact Wellfound city selected by the California search page gets a CA qualifier; other location text is preserved. Wellfound remote-only jobs retain that flag. Public search pages are incomplete samples and cannot supply closure evidence.

`linkedin-index.js` imports SerpApi organic search results with exact LinkedIn job host/path validation, two known role/company/location title formats, and canonical numeric LinkedIn IDs. Truncated records are not guessed. No LinkedIn page fetch occurs. This extra search shares the SerpApi key and has its own 26-hour request reservation; Google Jobs plus LinkedIn consume at most 58 requests per rolling 31 days from this database.
