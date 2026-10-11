# Official CS internship sources — September 2026 verification

Each enabled source below returned valid public JSON and passed the app’s actual adapter. Counts use the app’s starting Bay Area preferences, not a particular saved user search. These are listing counts before cross-source URL deduplication. No accounts, credentials, or paid data APIs were used.

| Employer / official sample | Bay Area technical internships | With supported skill mentions | Download via scoped adapter |
| --- | ---: | ---: | ---: |
| [Roblox](https://careers.roblox.com/jobs/8072713) | 1 | 1 | 307 KB |
| [Robinhood](https://boards.greenhouse.io/robinhood/jobs/8142963) | 4 | 2 | 201 KB |
| [Verkada](https://job-boards.greenhouse.io/verkada/jobs/5210942007) | 5 | 4 | 304 KB |
| [Scale AI](https://job-boards.greenhouse.io/scaleai/jobs/4730845005) | 1 | 1 | 208 KB |
| [HP IQ](https://job-boards.greenhouse.io/hpiq/jobs/6176783004) | 7 | 5 | 103 KB |
| [DoorDash](https://job-boards.greenhouse.io/doordashusa/jobs/8171041) | 1 | 1 | 1,301 KB |

Public API: [Greenhouse Job Board API documentation](https://docs.greenhouse.io/job-board.html). Full board responses with descriptions ranged from 435 KB to 8.55 MB for these employers. The internship-only adapter uses the index plus individual job details instead. These are response-size measurements, not Worker CPU measurements.

The existing [Simplify/Pitt CSC list](https://github.com/SimplifyJobs/Summer2027-Internships), [Vansh list](https://github.com/vanshb03/Summer2027-Internships), and [SpeedyApply list](https://github.com/speedyapply/2027-SWE-College-Jobs) remain connected for wider coverage. Official employer pages supply the source of truth when aggregator entries disagree.

Other candidates reviewed:

- [Pinterest university recruiting](https://www.pinterestcareers.com/early-career/university-recruiting/): legitimate program, but no technical internships in the public feed at verification; not enabled in this expansion.
- [Discord board](https://job-boards.greenhouse.io/discord): feed worked, but no current internships; not enabled.
- [Commure careers](https://www.commure.com/careers) and [Abridge careers](https://www.abridge.com/life-at-abridge): relevant programs, but the tested Ashby feed requests returned HTTP 403 from this environment. Not enabled without a successful feed validation.
- Sentry and Retool: the tested Greenhouse board tokens returned 404; not enabled based on guessed or stale endpoints.
- [ApplyGuy internship list](https://github.com/ApplyGuy/2027-Internships): a public aggregated list was found, but the expansion prioritizes verified employer feeds over another overlapping aggregator. Not connected.

Search indexes can show expired pages. The live public feeds were checked separately before adding configuration. Vacancy availability and eligibility can change; users still apply and confirm requirements on the employer’s site.

## September 16 coverage expansion

Verified `https://boards-api.greenhouse.io/v1/boards/asana/jobs` (99 listings) and `https://boards-api.greenhouse.io/v1/boards/airtable/jobs` (16 listings), both HTTP 200 with valid indexes. Neither index contained internship titles at verification time. Both are now monitored using the existing bounded internship-detail adapter for future postings. Employer references: https://asana.com/jobs/university-recruiting and https://www.airtable.com/careers. Counts are snapshots, not promises of open internships. Native LinkedIn/Handshake alerts remain user-managed subscriptions; setup links are included in the app.
