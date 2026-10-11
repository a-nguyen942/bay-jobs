import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { canonicalizeUrl, matchesSearch } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
import { checkSources } from '../worker/monitor.js';
import worker, { createWorker } from '../worker/index.js';
import { runCheck, CheckInProgressError, CheckCooldownError } from '../worker/check.js';
import { greenhouseSource } from '../worker/sources/greenhouse.js';
import { githubSource } from '../worker/sources/github.js';
import { sources as configuredSources } from '../config/sources.js';
let runtime;
let db;
before(async () => {
    runtime = await getPlatformProxy({
        configPath: 'wrangler.json', persist: false, remoteBindings: false,
    });
    db = runtime.env.DB;
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const migration = await readFile(new URL(name, directory), 'utf8');
        await db.batch(migration.split('--> statement-breakpoint').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    }
});
after(async () => { await runtime?.dispose(); });
beforeEach(async () => { await db.batch([db.prepare('DELETE FROM jobs'), db.prepare('DELETE FROM source_runs'), db.prepare('DELETE FROM monitor_lock'), db.prepare('DELETE FROM manual_scans'), db.prepare('DELETE FROM scan_retries'), db.prepare('DELETE FROM manual_check_budget'), db.prepare('DELETE FROM work_budget_days'), db.prepare('DELETE FROM search_settings'), db.prepare('DELETE FROM source_feed_cache'), db.prepare('DELETE FROM source_integrity'), db.prepare('DELETE FROM source_checks'), db.prepare('DELETE FROM filtered_listings')]); });
const listing = { sourceJobId: '42', title: 'Software Engineer', company: 'Example', location: 'San Jose, CA', url: 'https://job-boards.greenhouse.io/example/jobs/42', postedAt: null };
const source = (jobs, id = 'example') => ({ id, label: id, fetchListings: async () => jobs });

test('manual LinkedIn and Handshake imports normalize links and preserve duplicate application state', async () => {
    const save = body => worker.fetch(new Request('http://localhost/api/jobs/import', {
        method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), runtime.env);
    const body = { url: 'https://www.linkedin.com/jobs/view/software-engineer-at-example-123456?trackingId=abc', title: 'Software Engineer', company: 'Example', location: 'Remote' };
    await db.prepare('UPDATE notification_settings SET enabled = 1 WHERE id = 1').run();
    try {
        const created = await save(body);
        assert.equal(created.status, 201);
        const first = await created.json();
        assert.equal(first.job.canonicalUrl, 'https://www.linkedin.com/jobs/view/123456');
        assert.equal(first.job.sourceLabel, 'LinkedIn · Manual');
        assert.ok(first.job.seenAt);
        await db.prepare("UPDATE jobs SET application_status = 'applied' WHERE id = ?").bind(first.job.id).run();
        const duplicate = await save({ ...body, title: 'Different title', url: 'https://www.linkedin.com/jobs/view/123456/' });
        assert.equal(duplicate.status, 200);
        const saved = await duplicate.json();
        assert.equal(saved.created, false);
        assert.equal(saved.job.applicationStatus, 'applied');
        assert.equal(saved.job.title, body.title);
        assert.equal(saved.job.firstFoundAt, first.job.firstFoundAt);
        const handshake = await (await save({ ...body, url: 'https://school.joinhandshake.com/jobs/789?ref=search' })).json();
        assert.equal(handshake.job.canonicalUrl, 'https://app.joinhandshake.com/stu/jobs/789');
        assert.equal(handshake.job.sourceLabel, 'Handshake · Manual');
        assert.equal((await save({ ...body, url: 'https://app.joinhandshake.com/stu/jobs/789' })).status, 200);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 2);
        assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM notification_events').first()).count, 0);
    } finally {
        await db.prepare('UPDATE notification_settings SET enabled = 0 WHERE id = 1').run();
    }
});

test('manual imports reject foreign writes, invalid fields and unsafe URLs without saving', async () => {
    const body = { url: 'https://example.com/jobs/1', title: 'Software Engineer', company: 'Example', location: 'San Jose, CA' };
    const request = (value, origin = 'http://localhost') => worker.fetch(new Request('http://localhost/api/jobs/import', {
        method: 'POST', headers: { Origin: origin }, body: JSON.stringify(value),
    }), runtime.env);
    assert.equal((await request(body, 'https://other.example')).status, 403);
    for (const invalid of [null, [], { ...body, title: '' }, { ...body, company: 'a'.repeat(201) },
        { ...body, url: 'javascript:alert(1)' }, { ...body, url: 'https://user:secret@example.com/job' },
        { ...body, url: 'https://linkedin.com/jobs/search/' }, { ...body, applicationStatus: 'applied' }])
        assert.equal((await request(invalid)).status, 400);
    assert.equal((await worker.fetch(new Request('http://localhost/api/jobs/import'), runtime.env)).status, 405);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first()).count, 0);
});

test('GitHub and board imports deduplicate application URLs and source health reflects configured sources only', async () => {
    const repo = githubSource({ id: 'repo', owner: 'Example', repo: 'Jobs', branch: 'main', format: 'vansh' }, async () => Response.json([
        { id: 'repo-job', title: listing.title, company_name: listing.company, locations: [listing.location],
            url: `${listing.url}?utm_source=github`, active: true, is_visible: true, season: 'Summer' },
    ]));
    const board = source([listing]);
    await checkSources(db, [board, repo, { id: 'removed', label: 'Removed', fetchListings: async () => { throw new Error('Old failure'); } }]);
    const app = createWorker([board, repo, source([], 'unchecked')]);
    const state = await (await app.fetch(new Request('http://localhost/api/jobs'), runtime.env)).json();
    assert.equal(state.jobs.length, 1);
    assert.equal(state.monitor.sourceCount, 3);
    assert.equal(state.monitor.sources.find(item => item.sourceId === 'repo').matchedCount, 1);
    assert.equal(state.monitor.sources.find(item => item.sourceId === 'unchecked').lastSuccessAt, null);
    assert.deepEqual(state.monitor.errors, []);
});
test('repeat imports merge tracking variants and preserve user state and first discovery', async () => {
    await checkSources(db, [source([listing, { ...listing, url: `${listing.url}?utm_source=github` }])]);
    const initial = await db.prepare('SELECT id, first_found_at FROM jobs').first();
    assert.ok(initial);
    await db.prepare("UPDATE jobs SET seen_at = '2026-01-01T00:00:00Z', application_status = 'applied' WHERE id = ?").bind(initial.id).run();
    await checkSources(db, [source([{ ...listing, title: 'Software Engineer II', url: `${listing.url}?gh_src=linkedin` }], 'second-source')]);
    const rows = await db.prepare('SELECT * FROM jobs').all();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].application_status, 'applied');
    assert.equal(rows.results[0].seen_at, '2026-01-01T00:00:00Z');
    assert.equal(rows.results[0].first_found_at, initial.first_found_at);
    assert.equal(rows.results[0].title, 'Software Engineer II');
});
test('source failure retains jobs and last success, records error, and allows another source to run', async () => {
    await checkSources(db, [source([listing])]);
    const before = await db.prepare("SELECT last_success_at FROM source_runs WHERE source_id = 'example'").first();
    await checkSources(db, [
        { id: 'example', label: 'example', fetchListings: async () => { throw new Error('Upstream unavailable'); } },
        source([{ ...listing, url: 'https://example.com/jobs/99' }], 'healthy'),
    ]);
    const failed = await db.prepare("SELECT * FROM source_runs WHERE source_id = 'example'").first();
    assert.equal(failed?.last_success_at, before?.last_success_at);
    assert.equal(failed?.error, 'Upstream unavailable');
    assert.equal((await db.prepare('SELECT * FROM jobs').all()).results.length, 2);
});
test('out-of-area and unrelated roles are filtered before persistence', async () => {
    const report = await checkSources(db, [source([listing, { ...listing, location: 'New York, NY' }, { ...listing, title: 'Sales Manager' }])]);
    assert.equal(report[0].matched, 1);
    assert.equal(report[0].inserted, 1);
});
test('empty successful feeds never erase saved applications', async () => {
    await checkSources(db, [source([listing])]);
    await checkSources(db, [source([])]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first())?.count, 1);
});
test('schema rejects invalid application statuses', async () => {
    await checkSources(db, [source([listing])]);
    await assert.rejects(db.prepare("UPDATE jobs SET application_status = 'made-up'").run());
});
test('canonical links preserve job identifiers and reject executable URLs', () => {
    assert.notEqual(canonicalizeUrl('https://example.com/apply?job=1'), canonicalizeUrl('https://example.com/apply?job=2'));
    assert.equal(canonicalizeUrl('https://boards.greenhouse.io/example/jobs/42?utm_medium=email#apply'), listing.url);
    assert.throws(() => canonicalizeUrl('javascript:alert(1)'));
});
test('geography matching uses complete city names and excludes remote-only roles by default', () => {
    assert.equal(matchesSearch({ title: listing.title, location: 'Oakland, CA' }, searchPreferences), true);
    assert.equal(matchesSearch({ title: listing.title, location: 'Remote, US' }, searchPreferences), false);
    assert.equal(matchesSearch({ title: listing.title, location: 'Berkeleyshire' }, searchPreferences), false);
});
test('worker API persists seen and application state independently', async () => {
    await checkSources(db, [source([listing])]);
    const response = await worker.fetch(new Request('http://localhost/api/jobs'), runtime.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const inbox = await response.json();
    const job = inbox.jobs[0];
    assert.equal(job.isDemo, false);
    const patch = (body) => worker.fetch(new Request(`http://localhost/api/jobs/${job.id}`, {
        method: 'PATCH', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), runtime.env);
    const seen = await (await patch({ seen: true })).json();
    assert.ok(seen.seenAt);
    assert.equal(seen.applicationStatus, 'considering');
    const applied = await (await patch({ applicationStatus: 'applied' })).json();
    assert.equal(applied.seenAt, seen.seenAt);
    assert.equal(applied.applicationStatus, 'applied');
    const unseen = await (await patch({ seen: false })).json();
    assert.equal(unseen.seenAt, null);
    assert.equal(unseen.applicationStatus, 'applied');
    const saved = await (await worker.fetch(new Request('http://localhost/api/jobs'), runtime.env)).json();
    assert.equal(saved.jobs[0].applicationStatus, 'applied');
});
test('worker rejects invalid updates and cross-origin writes without changing saved jobs', async () => {
    await checkSources(db, [source([listing])]);
    const job = await db.prepare('SELECT id FROM jobs').first();
    assert.ok(job);
    for (const body of [{}, { applicationStatus: 'made-up' }, { seen: 'yes' }, { title: 'Changed' }, []]) {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs/${job.id}`, {
            method: 'PATCH', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body),
        }), runtime.env);
        assert.equal(response.status, 400);
    }
    for (const origin of ['https://another.example', '']) {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs/${job.id}`, {
            method: 'PATCH', headers: { Origin: origin }, body: JSON.stringify({ seen: true }),
        }), runtime.env);
        assert.equal(response.status, 403);
    }
    const saved = await db.prepare('SELECT title, seen_at, application_status FROM jobs').first();
    assert.equal(saved?.title, listing.title);
    assert.equal(saved?.seen_at, null);
    assert.equal(saved?.application_status, 'considering');
});
test('worker returns JSON errors for unknown API paths, missing jobs, and unsupported methods', async () => {
    const cases = [
        ['/api/missing', 'GET', 404], ['/api/jobs', 'POST', 405], ['/api/jobs/missing', 'GET', 405],
        ['/api/jobs/missing', 'PATCH', 404], ['/api/jobs/%XX', 'PATCH', 400],
    ];
    for (const [path, method, code] of cases) {
        const response = await worker.fetch(new Request(`http://localhost${path}`, {
            method, headers: { Origin: 'http://localhost' }, ...(method === 'PATCH' ? { body: '{"seen":true}' } : {}),
        }), runtime.env);
        assert.equal(response.status, code);
        assert.match(response.headers.get('Content-Type') ?? '', /application\/json/);
    }
});
test('manual check imports a board through the adapter and repeating it adds no duplicates', async () => {
    const board = greenhouseSource({ id: 'test-board', company: 'Test', boardToken: 'test' }, async () => Response.json({ jobs: [
            { id: 42, title: listing.title, location: { name: listing.location }, absolute_url: listing.url },
            { id: 43, title: listing.title, location: { name: 'Newark, NJ' }, absolute_url: 'https://example.com/jobs/43' },
            { id: 44, title: 'Software Sales Representative', location: { name: listing.location }, absolute_url: 'https://example.com/jobs/44' },
        ] }));
    const app = createWorker([board]);
    const request = () => new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' } });
    const first = await app.fetch(request(), runtime.env);
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { report: [{ sourceId: 'test-board', inserted: 1, matched: 1, error: null }] });
    const row = await db.prepare('SELECT id FROM jobs').first();
    assert.ok(row);
    await db.prepare("UPDATE jobs SET application_status = 'applied' WHERE id = ?").bind(row.id).run();
    const blocked = await app.fetch(request(), runtime.env);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
    await db.prepare('UPDATE manual_check_budget SET next_allowed_at = 0').run();
    const repeat = await app.fetch(request(), runtime.env);
    assert.deepEqual(await repeat.json(), { report: [{ sourceId: 'test-board', inserted: 0, matched: 1, error: null }] });
    assert.equal((await db.prepare('SELECT application_status FROM jobs').first())?.application_status, 'applied');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM monitor_lock').first())?.count, 0);
});
test('manual check rejects other origins and GET requests before contacting sources', async () => {
    let requests = 0;
    const app = createWorker([{ id: 'test', label: 'Test', fetchListings: async () => { requests++; return []; } }]);
    for (const origin of ['', 'https://other.example']) {
        const response = await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: origin } }), runtime.env);
        assert.equal(response.status, 403);
    }
    const response = await app.fetch(new Request('http://localhost/api/check'), runtime.env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('Allow'), 'POST');
    assert.equal(requests, 0);
});
test('manual and scheduled runs share a lock and an expired lock can be recovered', async () => {
    let started;
    const entering = new Promise(resolve => { started = resolve; });
    let finish;
    const feed = new Promise(resolve => { finish = resolve; });
    const pending = runCheck(db, [{ id: 'slow', label: 'Slow', fetchListings: async () => { started(); return feed; } }]);
    await entering;
    try {
        await assert.rejects(runCheck(db, [source([listing])]), CheckInProgressError);
        const response = await createWorker([]).fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' } }), runtime.env);
        assert.equal(response.status, 409);
    }
    finally {
        finish([]);
        await pending;
    }
    await db.prepare("INSERT INTO monitor_lock VALUES (1, 'interrupted', '2000-01-01T00:00:00Z')").run();
    assert.equal((await runCheck(db, [source([listing])]))[0].inserted, 1);
});
test('a broken source reports its error, allows healthy sources, and releases the run lock', async () => {
    const broken = greenhouseSource({ id: 'broken', company: 'Broken', boardToken: '../invalid' }, async () => { throw new Error('Should never fetch'); });
    const report = await runCheck(db, [broken, source([listing])]);
    assert.match(report[0].error ?? '', /board token/);
    assert.equal(report[1].inserted, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM monitor_lock').first())?.count, 0);
});
test('scheduled handler imports through the same runner and skips a held lease', async () => {
    let fetches = 0;
    const app = createWorker([{ id: 'scheduled', label: 'Scheduled board', fetchListings: async () => { fetches++; return [listing]; } }]);
    const event = { scheduledTime: Math.floor(Date.now() / 3600000) * 3600000, cron: '*/30 * * * *', noRetry() { } };
    await app.scheduled(event, runtime.env);
    assert.equal(fetches, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first())?.count, 1);
    await db.prepare('INSERT INTO monitor_lock VALUES (1, ?, ?)').bind('manual', new Date(Date.now() + 60_000).toISOString()).run();
    await app.scheduled(event, runtime.env);
    assert.equal(fetches, 1);
});
test('configured cron covers every source each hour, including overnight and after source failures', async () => {
    const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
    assert.equal(config.triggers.crons.length, 1);
    const cron = config.triggers.crons[0];
    // Every hour and every day, with one minute slot per configured source.
    assert.equal(cron, `0-${configuredSources.length * 2} * * * *`);
    const calls = [];
    const feeds = configuredSources.map(({ id }, index) => ({ id, label: id, async fetchListings() {
        calls.push(id);
        if (index === 1) throw new Error('offline');
        return [];
    } }));
    const app = createWorker(feeds);
    const hour = Date.parse('2026-09-15T07:00:00Z'); // Midnight Pacific.
    for (let cycle = 0; cycle < 2; cycle++) {
        for (let minute = 0; minute < feeds.length; minute++) {
            const scheduledTime = hour + cycle * 3_600_000 + minute * 60_000;
            await app.scheduled({ scheduledTime, cron, noRetry() {} }, { DB: db });
            assert.equal(calls.length, cycle * feeds.length + minute + 1);
            // Keep rotation deterministic even when the emulator clock does not advance.
            await db.prepare('UPDATE source_runs SET last_attempt_at = ? WHERE source_id = ?')
                .bind(new Date(scheduledTime).toISOString(), calls.at(-1)).run();
        }
        assert.deepEqual(calls.slice(cycle * feeds.length), configuredSources.map(source => source.id));
    }
});
async function seedLargeInbox() {
    await db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 605)
    INSERT INTO jobs (id, canonical_url, title, company, location, source_label, first_found_at, last_seen_at, application_status)
    SELECT printf('job-%04d', n), 'https://example.com/jobs/' || n,
      CASE WHEN n > 600 THEN 'Legacy 100%_team''s Engineer' ELSE 'Software Engineer' END,
      'Test company', 'San Jose, CA', 'Test',
      CASE WHEN n > 600 THEN '2020-01-01' ELSE '2026-01-01' END, '2026-01-01',
      CASE n WHEN 605 THEN 'applied' WHEN 604 THEN 'archived' WHEN 603 THEN 'interviewing' WHEN 602 THEN 'rejected' ELSE 'considering' END
    FROM sequence`).run();
}
test('all saved jobs remain reachable beyond 500 records with deterministic page ordering', async () => {
    await seedLargeInbox();
    const ids = [];
    for (let page = 1; page <= 13; page++) {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?page=${page}`), runtime.env);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.pagination.total, 604);
        assert.equal(body.pagination.pages, 13);
        assert.equal(body.jobs.length, page === 13 ? 4 : 50);
        assert.equal(body.summary.unseen, 604);
        assert.equal(body.summary.total, 605);
        ids.push(...body.jobs.map(job => job.id));
    }
    assert.equal(new Set(ids).size, 604);
    assert.deepEqual(ids, [...ids].sort());
    assert.ok(ids.includes('job-0605'));
    assert.ok(!ids.includes('job-0604'));
});
test('search and every status view query older jobs before pagination', async () => {
    await seedLargeInbox();
    const { backfillStatement } = await import('../scripts/backfill-search.js');
    const legacy = (await db.prepare('SELECT id,title,company,location FROM jobs').all()).results;
    for (let offset = 0; offset < legacy.length; offset += 100)
        await db.prepare(backfillStatement('jobs', legacy.slice(offset, offset + 100))).run();
    for (const [view, id] of [['applied', '0605'], ['archived', '0604'], ['interviewing', '0603'], ['rejected', '0602'], ['considering', '0601']]) {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?view=${view}&q=legacy`), runtime.env);
        const body = await response.json();
        assert.equal(body.pagination.total, 1);
        assert.equal(body.jobs[0].id, `job-${id}`);
        assert.equal(body.summary.unseen, 604);
    }
    for (const query of ["100%_team's", 'LEGACY', 'test company', 'San Jose', "' OR 1=1 --"]) {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?q=${encodeURIComponent(query)}`), runtime.env);
        const body = await response.json();
        assert.equal(body.pagination.total, query.includes('OR 1=1') ? 0 : query === 'LEGACY' || query.includes('100%') ? 4 : 604);
    }
    await db.prepare("UPDATE jobs SET seen_at = '2026-01-01' WHERE id = 'job-0605'").run();
    const unseen = await (await worker.fetch(new Request('http://localhost/api/jobs?view=new&q=legacy'), runtime.env)).json();
    assert.equal(unseen.pagination.total, 3);
    assert.equal(unseen.summary.unseen, 603);
});
test('invalid pagination and filter inputs return 400 and an empty page retains accurate totals', async () => {
    for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=1000001', 'view=invalid', `q=${'a'.repeat(201)}`]) {
        assert.equal((await worker.fetch(new Request(`http://localhost/api/jobs?${query}`), runtime.env)).status, 400);
    }
    await checkSources(db, [source([listing])]);
    const result = await (await worker.fetch(new Request('http://localhost/api/jobs?page=2'), runtime.env)).json();
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.pagination, { page: 2, pageSize: 50, pages: 1, total: 1 });
});

test('preferences API persists valid settings and rejects invalid or cross-origin saves', async () => {
    const read = () => worker.fetch(new Request('http://localhost/api/preferences'), runtime.env);
    const initial = await (await read()).json();
    assert.equal(initial.preferences.experienceLevels.length, 4);
    const preferences = { ...initial.preferences, locations: ['San Jose'], experienceLevels: ['internship'], keywords: ['software'], excludedKeywords: ['senior'] };
    const save = (body, origin = 'http://localhost') => worker.fetch(new Request('http://localhost/api/preferences', {
        method: 'PATCH', headers: { Origin: origin }, body: JSON.stringify(body),
    }), runtime.env);
    assert.equal((await save(preferences)).status, 200);
    assert.deepEqual((await (await read()).json()).preferences, preferences);
    assert.equal((await save(initial.preferences, 'https://foreign.example')).status, 403);
    for (const body of [{ ...preferences, locations: [] }, { ...preferences, experienceLevels: [] },
        { ...preferences, locations: ['New York'] }, { ...preferences, includeRemote: 'yes' },
        { ...preferences, keywords: ['x'.repeat(81)] }, { ...preferences, unknown: true }])
        assert.equal((await save(body)).status, 400);
    assert.deepEqual((await (await read()).json()).preferences, preferences);
});

test('saved preferences filter discoveries while preserving saved jobs and their availability', async () => {
    await checkSources(db, [source([listing])]);
    const preferences = { locations: ['San Jose'], experienceLevels: ['internship'], includeRemote: false, keywords: [], excludedKeywords: [] };
    await db.prepare('INSERT INTO search_settings VALUES (1, ?)').bind(JSON.stringify(preferences)).run();
    const internship = { ...listing, url: 'https://example.com/intern', title: 'Software Engineer Intern' };
    for (let i = 0; i < 2; i++) await checkSources(db, [source([listing, internship])]);
    const jobs = (await db.prepare('SELECT title, closed_at FROM jobs').all()).results;
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every(job => job.closed_at === null));
    assert.equal((await db.prepare('SELECT matched_count FROM source_runs').first()).matched_count, 1);
});

test('two successful misses flag possible closure; failures do not count and reappearance clears it', async () => {
    await checkSources(db, [source([listing])]);
    await db.prepare("UPDATE jobs SET application_status = 'applied'").run();
    await checkSources(db, [source([])]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
    await checkSources(db, [{ id: 'example', label: 'example', fetchListings: async () => { throw new Error('Offline'); } }]);
    assert.equal((await db.prepare('SELECT missing_count FROM job_sources').first()).missing_count, 1);
    await checkSources(db, [source([])]);
    assert.ok((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at);
    const inbox = await (await worker.fetch(new Request('http://localhost/api/jobs'), runtime.env)).json();
    assert.ok(inbox.jobs[0].closedAt);
    assert.equal(inbox.jobs[0].applicationStatus, 'applied');
    await checkSources(db, [source([listing])]);
    const restored = await db.prepare('SELECT closed_at, application_status FROM jobs').first();
    assert.equal(restored.closed_at, null);
    assert.equal(restored.application_status, 'applied');
});

test('a job remains available while another observed source still carries it', async () => {
    await checkSources(db, [source([listing], 'a'), source([listing], 'b')]);
    for (let i = 0; i < 2; i++) await checkSources(db, [source([], 'a')]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
    for (let i = 0; i < 2; i++) await checkSources(db, [source([], 'b')]);
    assert.ok((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at);
    await checkSources(db, [source([listing], 'b')]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
});

test('availability updates roll back together when the source success record cannot be committed', async () => {
    await checkSources(db, [source([listing])]);
    await checkSources(db, [source([])]);
    await db.prepare(`CREATE TRIGGER fail_success BEFORE UPDATE OF last_success_at ON source_runs
        BEGIN SELECT RAISE(ABORT, 'forced availability failure'); END`).run();
    try {
        const report = await checkSources(db, [source([])]);
        assert.ok(report[0].error);
        assert.equal((await db.prepare('SELECT missing_count FROM job_sources').first()).missing_count, 1);
        assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
    } finally { await db.prepare('DROP TRIGGER fail_success').run(); }
});

test('notes and follow-up dates survive imports, closure flags, and status changes', async () => {
    await checkSources(db, [source([listing])]);
    const job = await db.prepare('SELECT id FROM jobs').first();
    const patch = body => worker.fetch(new Request(`http://localhost/api/jobs/${job.id}`, { method: 'PATCH', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body) }), runtime.env);
    const response = await patch({ notes: 'Recruiter: Alex\nAsk about team placement.', followUpDate: '2026-09-20', applicationStatus: 'applied' });
    assert.equal(response.status, 200);
    await checkSources(db, [source([{ ...listing, title: 'Software Engineer II' }])]);
    await checkSources(db, [source([])]);
    await checkSources(db, [source([])]);
    const saved = await (await patch({ seen: true })).json();
    assert.equal(saved.notes, 'Recruiter: Alex\nAsk about team placement.');
    assert.equal(saved.followUpDate, '2026-09-20');
    assert.equal(saved.applicationStatus, 'applied');
    assert.ok(saved.closedAt);
    for (const invalid of [{ notes: null }, { notes: 'a'.repeat(10001) }, { followUpDate: '2026-02-30' }, { followUpDate: 'tomorrow' }, { followUpDate: '' }])
        assert.equal((await patch(invalid)).status, 400);
    const cleared = await (await patch({ notes: '', followUpDate: null })).json();
    assert.equal(cleared.notes, '');
    assert.equal(cleared.followUpDate, null);
});

test('follow-up view orders dates before pagination and excludes archived or unscheduled jobs', async () => {
    await checkSources(db, [source([listing, { ...listing, url: 'https://example.com/early' }, { ...listing, url: 'https://example.com/archived' }, { ...listing, url: 'https://example.com/none' }])]);
    await db.prepare("UPDATE jobs SET follow_up_date = '2026-09-30' WHERE canonical_url = ?").bind(listing.url).run();
    await db.prepare("UPDATE jobs SET follow_up_date = '2026-09-15' WHERE canonical_url = 'https://example.com/early'").run();
    await db.prepare("UPDATE jobs SET follow_up_date = '2026-09-01', application_status = 'archived' WHERE canonical_url = 'https://example.com/archived'").run();
    const state = await (await worker.fetch(new Request('http://localhost/api/jobs?view=follow_up'), runtime.env)).json();
    assert.equal(state.pagination.total, 2);
    assert.deepEqual(state.jobs.map(job => job.followUpDate), ['2026-09-15', '2026-09-30']);
});

test('manual cooldown survives failures and scheduled checks bypass it; exact expiry allows retry', async () => {
    let calls = 0;
    const sources = [{ id: 'fail', label: 'Fail', fetchListings: async () => { calls++; throw new Error('offline'); } }];
    await runCheck(db, sources, { manual: true, clock: () => 1000000 });
    await assert.rejects(runCheck(db, sources, { manual: true, clock: () => 1299999 }), CheckCooldownError);
    assert.equal(calls, 1);
    await runCheck(db, sources, { clock: () => 1000001 });
    assert.equal(calls, 2);
    await runCheck(db, sources, { manual: true, clock: () => 1300000 });
    assert.equal(calls, 3);
});

test('rotation checks one oldest source per invocation, advances past failures, and wraps', async () => {
    const calls = [];
    const feeds = ['a', 'b', 'c'].map(id => ({ id, label: id, fetchListings: async () => {
        calls.push(id);
        if (id === 'b') throw new Error('offline');
        return [];
    } }));
    for (let i = 0; i < 4; i++) {
        const report = await runCheck(db, feeds, { rotate: true });
        assert.equal(report.length, 1);
        // Explicit timestamps make rotation independent of timer precision.
        await db.prepare('UPDATE source_runs SET last_attempt_at = ? WHERE source_id = ?')
            .bind(new Date(1700000000000 + i * 1000).toISOString(), calls.at(-1)).run();
    }
    assert.deepEqual(calls, ['a', 'b', 'c', 'a']);
});
test('unchanged repeats avoid job writes but changed source fields still update immediately', async () => {
    await checkSources(db, [source([listing])]);
    await db.prepare("CREATE TRIGGER reject_redundant BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'unexpected job write'); END").run();
    try {
        const report = await checkSources(db, [source([listing])]);
        assert.equal(report[0].error, null);
    } finally { await db.prepare('DROP TRIGGER reject_redundant').run(); }
    await checkSources(db, [source([{ ...listing, title: 'Senior Software Engineer' }])]);
    assert.equal((await db.prepare('SELECT title FROM jobs').first()).title, 'Senior Software Engineer');
});

// The validators and URL snapshots must survive Worker restarts in D1.
async function conditionalBoard() {
    const { createSources } = await import('../worker/sources/index.js');
    const state = { etag: '"v1"', jobs: [listing], requests: [], invalid: false };
    const request = async (_url, options) => {
        const validator = new Headers(options.headers).get('If-None-Match');
        state.requests.push(validator);
        if (validator === state.etag) return new Response(null, { status: 304 });
        return Response.json(state.invalid ? {} : { jobs: state.jobs.map(job => ({
            id: job.sourceJobId, title: job.title, absolute_url: job.url, location: { name: job.location },
        })) }, { headers: { ETag: state.etag } });
    };
    const make = () => createSources([{ id: 'conditional-board', kind: 'greenhouse', company: 'Example', boardToken: 'example' }], request)[0];
    return { state, make };
}

test('unchanged feeds preserve matches, refresh health, and advance missing jobs to closed', async () => {
    const { state, make } = await conditionalBoard();
    await checkSources(db, [make()]);
    await db.prepare("UPDATE source_runs SET error = 'old error' WHERE source_id = 'conditional-board'").run();
    const repeat = await checkSources(db, [make()]);
    assert.equal(state.requests.at(-1), '"v1"');
    assert.deepEqual(repeat[0], { sourceId: 'conditional-board', inserted: 0, matched: 1, error: null });
    assert.equal((await db.prepare("SELECT error FROM source_runs WHERE source_id = 'conditional-board'").first()).error, null);
    state.jobs = []; state.etag = '"v2"';
    await checkSources(db, [make()]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
    await checkSources(db, [make()]);
    assert.ok((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n, 0);
});

test('preference changes and UTC-day changes force full imports despite an unchanged ETag', async () => {
    const { state, make } = await conditionalBoard();
    state.jobs = [{ ...listing, location: 'Remote, US' }];
    await checkSources(db, [make()]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 0);
    const { defaultPreferences } = await import('../worker/preferences.js');
    await db.prepare('INSERT INTO search_settings VALUES (1, ?)').bind(JSON.stringify({ ...defaultPreferences(), includeRemote: true })).run();
    await checkSources(db, [make()]);
    assert.equal(state.requests.at(-1), null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 1);
    await db.prepare("UPDATE source_feed_cache SET imported_at = '2000-01-01T00:00:00.000Z'").run();
    await db.prepare("UPDATE jobs SET last_seen_at = '2000-01-01T00:00:00.000Z'").run();
    await checkSources(db, [make()]);
    assert.equal(state.requests.at(-1), null);
    assert.notEqual((await db.prepare('SELECT last_seen_at FROM jobs').first()).last_seen_at, '2000-01-01T00:00:00.000Z');
});

test('failed parses and failed availability commits never save a new validator', async () => {
    const { state, make } = await conditionalBoard();
    state.invalid = true;
    assert.ok((await checkSources(db, [make()]))[0].error);
    assert.equal(await db.prepare("SELECT * FROM source_feed_cache WHERE source_id = 'conditional-board'").first(), null);
    state.invalid = false;
    await checkSources(db, [make()]);
    state.etag = '"v2"'; state.jobs = [];
    await db.prepare("CREATE TRIGGER fail_cache BEFORE UPDATE ON source_feed_cache BEGIN SELECT RAISE(ABORT, 'cache failure'); END").run();
    try {
        assert.ok((await checkSources(db, [make()]))[0].error);
        assert.equal((await db.prepare('SELECT etag FROM source_feed_cache').first()).etag, '"v1"');
        assert.equal((await db.prepare('SELECT missing_count FROM job_sources').first()).missing_count, 0);
    } finally { await db.prepare('DROP TRIGGER fail_cache').run(); }
    await checkSources(db, [make()]);
    assert.equal(state.requests.at(-1), '"v1"');
    assert.equal((await db.prepare('SELECT etag FROM source_feed_cache').first()).etag, '"v2"');
});

test('unchanged snapshots discover provenance for jobs subsequently imported from another source', async () => {
    const { state, make } = await conditionalBoard();
    state.jobs = [{ ...listing, title: 'Account Executive' }];
    await checkSources(db, [make()]);
    await checkSources(db, [source([listing], 'another-board')]);
    await checkSources(db, [make()]);
    assert.equal((await db.prepare("SELECT missing_count FROM job_sources WHERE source_id = 'conditional-board'").first()).missing_count, 0);
    await checkSources(db, [source([], 'another-board')]);
    await checkSources(db, [source([], 'another-board')]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
});

test('changed conditional feeds queue new alerts once; 304 checks never queue duplicates', async () => {
    const { state, make } = await conditionalBoard();
    await db.prepare('UPDATE notification_settings SET enabled = 1 WHERE id = 1').run();
    try {
        await checkSources(db, [make()]);
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n, 0);
        state.etag = '"v2"';
        state.jobs.push({ ...listing, sourceJobId: '43', url: 'https://example.com/jobs/43' });
        await checkSources(db, [make()]);
        await checkSources(db, [make()]);
        assert.equal(state.requests.at(-1), '"v2"');
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n, 1);
    } finally { await db.prepare('UPDATE notification_settings SET enabled = 0 WHERE id = 1').run(); }
});

test('importance filters all pages and retains description tags across title-only sources', async () => {
    const jobs = Array.from({ length: 55 }, (_, i) => ({ ...listing, url: `https://example.com/jobs/${i}`, title: 'Software Engineer', description: 'Python JavaScript' }));
    jobs.push({ ...listing, url: 'https://example.com/top', title: 'Software Engineer Intern', description: '<p>Python, JS, C++</p>' });
    jobs.push({ ...listing, url: 'https://example.com/unknown', title: 'Software Engineer Intern' });
    jobs.push({ ...listing, url: 'https://example.com/international', title: 'Software Engineer, International', description: 'C++' });
    await checkSources(db, [source(jobs)]);
    const read = async query => {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?${query}`), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    let result = await read('sort=importance&skills=7');
    assert.equal(result.pagination.total, 58);
    assert.equal(result.jobs[0].canonicalUrl, 'https://example.com/top');
    assert.equal(result.jobs[0].skillMask, 7);
    result = await read('sort=importance&skills=4&skillMode=any&internships=true');
    assert.equal(result.pagination.total, 1);
    result = await read('skills=7&skillMode=all');
    assert.equal(result.pagination.total, 1);
    result = await read('skills=1&skillMode=any&page=2');
    assert.equal(result.pagination.total, 56);
    assert.equal(result.jobs.length, 6);
    assert.equal((await read('skills=0&skillMode=any')).pagination.total, 0);
    await checkSources(db, [source([{ ...jobs[55], description: undefined }], 'title-only')]);
    assert.equal((await read('skills=7&skillMode=all')).pagination.total, 1);
    await checkSources(db, [source(jobs.map((job, i) => i === 55 ? { ...job, description: 'Python' } : job))]);
    assert.equal((await read('skills=7&skillMode=all')).pagination.total, 0);
    for (const query of ['sort=oops', 'skills=64', 'skills=-1', 'skillMode=oops', 'internships=oops']) {
        assert.equal((await worker.fetch(new Request(`http://localhost/api/jobs?${query}`), runtime.env)).status, 400);
    }
});

test('Seen view includes opened listings, respects skill filters, and excludes archived and unseen jobs', async () => {
    await checkSources(db, [source([
        { ...listing, url: 'https://example.com/python', description: 'Python' },
        { ...listing, url: 'https://example.com/js', description: 'JavaScript' },
        { ...listing, url: 'https://example.com/unseen', description: 'Python' },
        { ...listing, url: 'https://example.com/archived', description: 'Python' },
    ])]);
    await db.prepare("UPDATE jobs SET seen_at = '2026-09-15T12:00:00Z' WHERE canonical_url != 'https://example.com/unseen'").run();
    await db.prepare("UPDATE jobs SET application_status = 'archived' WHERE canonical_url = 'https://example.com/archived'").run();
    const read = async query => {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?view=seen&${query}`), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    assert.equal((await read('')).pagination.total, 2);
    const filtered = await read('skills=2&skillMode=any');
    assert.equal(filtered.pagination.total, 1);
    assert.equal(filtered.jobs[0].canonicalUrl, 'https://example.com/python');
    const response = await worker.fetch(new Request(`http://localhost/api/jobs/${filtered.jobs[0].id}`, {
        method: 'PATCH', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ seen: false }),
    }), runtime.env);
    assert.equal(response.status, 200);
    assert.equal((await read('skills=2&skillMode=any')).pagination.total, 0);
});

test('favorites, deadlines and closure filters persist through imports and validate edits', async () => {
    const jobs = ['early', 'later', 'no-deadline', 'closed', 'archived'].map(id => ({ ...listing, url: `https://example.com/${id}`, description: 'Python' }));
    await checkSources(db, [source(jobs)]);
    const read = async query => {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?${query}`), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    const original = await read('');
    const job = original.jobs.find(job => job.canonicalUrl.endsWith('/early'));
    const update = body => worker.fetch(new Request(`http://localhost/api/jobs/${job.id}`, {
        method: 'PATCH', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body),
    }), runtime.env);
    let response = await update({ isFavorite: true, deadlineDate: '2026-10-01', notes: 'Keep this', followUpDate: '2026-09-28' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).isFavorite, true);
    await db.prepare("UPDATE jobs SET deadline_date = '2026-11-01' WHERE canonical_url = 'https://example.com/later'").run();
    await db.prepare("UPDATE jobs SET is_favorite = 1, application_status = 'archived' WHERE canonical_url = 'https://example.com/archived'").run();
    await checkSources(db, [source(jobs)]);
    let favorites = await read('view=favorites');
    assert.equal(favorites.pagination.total, 1);
    assert.equal(favorites.jobs[0].deadlineDate, '2026-10-01');
    assert.equal(favorites.jobs[0].notes, 'Keep this');
    assert.equal(favorites.jobs[0].firstFoundAt, job.firstFoundAt);
    assert.deepEqual((await read('view=deadlines')).jobs.map(job => job.deadlineDate), ['2026-10-01', '2026-11-01']);
    assert.equal((await read('sort=deadline')).jobs.at(-1).deadlineDate, null);
    await db.prepare("UPDATE jobs SET closed_at = '2026-09-15T12:00:00Z' WHERE canonical_url = 'https://example.com/closed'").run();
    assert.equal((await read('hideClosed=true')).pagination.total, 3);
    assert.equal((await read('hideClosed=false')).pagination.total, 4);
    for (const body of [{ isFavorite: 'true' }, { deadlineDate: '2026-02-30' }, { deadlineDate: 'tomorrow' }]) assert.equal((await update(body)).status, 400);
    assert.equal((await update({ deadlineDate: null, isFavorite: false })).status, 200);
    assert.equal((await read('view=favorites')).pagination.total, 0);
    assert.equal((await read('view=deadlines')).pagination.total, 1);
    assert.equal((await worker.fetch(new Request('http://localhost/api/jobs?hideClosed=oops'), runtime.env)).status, 400);
});

test('source health counts consecutive failures and resets on successful recovery', async () => {
    const failed = { id: 'example', label: 'Example', fetchListings: async () => { throw new Error('offline'); } };
    for (let i = 0; i < 3; i++) await checkSources(db, [failed]);
    const app = createWorker([failed]);
    const read = async () => (await (await app.fetch(new Request('http://localhost/api/jobs'), runtime.env)).json()).monitor.sources[0];
    assert.equal((await read()).consecutiveFailures, 3);
    await checkSources(db, [source([listing])]);
    const healthy = await read();
    assert.equal(healthy.consecutiveFailures, 0);
    assert.equal(healthy.error, null);
    assert.ok(healthy.lastSuccessAt);
});

test('hourly scan summary counts configured-source results and discoveries independently of inbox filters', async () => {
    const active = source([
        { ...listing, url: 'https://example.com/first', description: 'Python' },
        { ...listing, url: 'https://example.com/second', description: 'Python' },
    ], 'active');
    const failed = { id: 'failed', label: 'Failed board', fetchListings: async () => { throw new Error('offline'); } };
    const waiting = source([], 'waiting');
    await checkSources(db, [active, failed, source([{ ...listing, url: 'https://example.com/removed' }], 'removed')]);
    // A duplicate source check does not add to the discovery count.
    await checkSources(db, [active]);
    await db.prepare("UPDATE jobs SET application_status = 'archived' WHERE canonical_url = 'https://example.com/first'").run();
    const app = createWorker([active, failed, waiting]);
    const read = async () => {
        const response = await app.fetch(new Request('http://localhost/api/jobs?view=new&skills=4&skillMode=all&q=not-found'), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    let result = await read();
    assert.equal(result.jobs.length, 0);
    assert.equal(result.monitor.scan.total, 3);
    assert.equal(result.monitor.scan.checked, 2);
    assert.equal(result.monitor.scan.succeeded, 1);
    assert.equal(result.monitor.scan.failed, 1);
    assert.equal(result.monitor.scan.waiting, 1);
    assert.equal(result.monitor.scan.newMatches, 2);
    assert.deepEqual(result.monitor.scan.failedSources, ['Failed board']);
    await checkSources(db, [source([], 'failed'), waiting]);
    result = await read();
    assert.equal(result.monitor.scan.status, 'complete');
    assert.equal(result.monitor.scan.checked, 3);
    assert.equal(result.monitor.scan.failed, 0);
    assert.equal(result.monitor.scan.newMatches, 2);
    await db.prepare("UPDATE jobs SET first_found_at = '2020-01-01T00:00:00.000Z'").run();
    await db.prepare("UPDATE source_runs SET last_attempt_at = '2020-01-01T00:00:00.000Z', last_success_at = '2020-01-01T00:00:00.000Z'").run();
    result = await read();
    assert.equal(result.monitor.scan.checked, 0);
    assert.equal(result.monitor.scan.newMatches, 0);
});

test('manual full scan uses one source per step, one cooldown, and blocks overlapping scheduled work', async () => {
    const calls = [];
    const feeds = ['one', 'two', 'three'].map(id => ({ id, label: id, fetchListings: async () => {
        calls.push(id);
        if (id === 'two') throw new Error('offline');
        return [{ ...listing, url: `https://example.com/${id}` }];
    } }));
    const app = createWorker(feeds);
    const post = body => app.fetch(new Request('http://localhost/api/check', {
        method: 'POST', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body),
    }), runtime.env);
    const started = await post({ action: 'start' });
    assert.equal(started.status, 200);
    let { scan } = await started.json();
    assert.equal(scan.total, 3);
    assert.deepEqual(calls, []);
    assert.equal((await post({ action: 'start' })).status, 409);
    await assert.rejects(runCheck(db, feeds, { rotate: true }), CheckInProgressError);
    assert.equal((await post({ action: 'step', token: scan.token, index: 1 })).status, 400);
    assert.equal((await post({ action: 'step', token: 'wrong-token', index: 0 })).status, 400);
    const budget = (await db.prepare('SELECT next_allowed_at FROM manual_check_budget').first()).next_allowed_at;
    for (let index = 0; index < 3; index++) {
        const response = await post({ action: 'step', token: scan.token, index });
        assert.equal(response.status, 200);
        scan = (await response.json()).scan;
        assert.equal(scan.nextIndex, index + 1);
        assert.equal(calls.length, index + 1);
        const repeated = await post({ action: 'step', token: scan.token, index });
        assert.deepEqual((await repeated.json()).scan, scan);
        assert.equal(calls.length, index + 1);
    }
    assert.equal(scan.done, true);
    assert.deepEqual(calls, ['one', 'two', 'three']);
    assert.equal(scan.report.filter(item => item.error).length, 1);
    assert.equal((await db.prepare('SELECT next_allowed_at FROM manual_check_budget').first()).next_allowed_at, budget);
    assert.equal((await post({ action: 'start' })).status, 429);
    await runCheck(db, feeds, { rotate: true });
    assert.equal(calls.length, 4);
});

test('expired manual scans release scheduling and invalid requests never fetch sources', async () => {
    const { startManualScan, stepManualScan, ManualScanError } = await import('../worker/check.js');
    let calls = 0;
    const feeds = [{ id: 'one', label: 'One', fetchListings: async () => { calls++; return []; } }];
    const now = Date.now();
    const scan = await startManualScan(db, feeds, () => now);
    await assert.rejects(stepManualScan(db, feeds, scan.token, 0, () => now + 120001), ManualScanError);
    await runCheck(db, feeds, { rotate: true, clock: () => now + 120001 });
    assert.equal(calls, 1);
    const app = createWorker(feeds);
    for (const body of [null, [], { action: 'oops' }, { action: 'step', token: scan.token, index: -1 }, { action: 'start', source: 'one' }]) {
        const response = await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body) }), runtime.env);
        assert.equal(response.status, 400);
    }
    assert.equal((await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'https://elsewhere.test' }, body: JSON.stringify({ action: 'start' }) }), runtime.env)).status, 403);
    assert.equal(calls, 1);
});

test('Needs review surfaces untagged internships despite skill filters and respects search, closure and archive filters', async () => {
    const jobs = ['unknown', 'tagged', 'closed', 'archived', 'experienced'].map(id => ({ ...listing,
        title: id === 'experienced' ? 'Software Engineer' : 'Software Engineer Intern, Summer 2027',
        url: `https://example.com/${id}`, description: id === 'tagged' ? 'Python' : '' }));
    await checkSources(db, [source(jobs)]);
    await db.prepare("UPDATE jobs SET application_status = 'archived' WHERE canonical_url = 'https://example.com/archived'").run();
    await db.prepare("UPDATE jobs SET closed_at = '2026-09-16T00:00:00Z' WHERE canonical_url = 'https://example.com/closed'").run();
    const read = async params => {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?view=review&skills=63&skillMode=all&internships=true&${params}`), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    const review = await read('');
    assert.equal(review.pagination.total, 2);
    assert.equal(review.summary.needsReview, 2);
    assert.ok(review.jobs.every(job => job.skillMask === 0));
    assert.equal((await read('hideClosed=true')).pagination.total, 1);
    assert.equal((await read('q=missing')).pagination.total, 0);
    assert.equal((await read('hideClosed=true')).jobs[0].canonicalUrl, 'https://example.com/unknown');
    await checkSources(db, [source([{ ...jobs[0], description: 'Python' }])]);
    await checkSources(db, [source([{ ...jobs[0], description: 'Python' }])]);
    assert.equal((await read('hideClosed=true')).pagination.total, 0);
});

test('recovery retries only failed or missing sources, at most once per source per hour', async () => {
    const calls = [];
    const feeds = ['healthy', 'failed', 'missing'].map(id => ({ id, label: id, fetchListings: async () => {
        calls.push(id);
        if (id === 'failed') throw new Error('offline');
        return [];
    } }));
    await checkSources(db, feeds.slice(0, 2));
    calls.length = 0;
    await runCheck(db, feeds, { recovery: true });
    await runCheck(db, feeds, { recovery: true });
    await runCheck(db, feeds, { recovery: true });
    assert.deepEqual(calls, ['missing', 'failed']);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM scan_retries').first()).n, 2);
    const nextHour = (Math.floor(Date.now() / 3600000) + 1) * 3600000;
    await runCheck(db, feeds, { recovery: true, clock: () => nextHour });
    assert.equal(calls.length, 3);
});

test('recovery honors an active manual scan and scheduled recovery fetches no healthy sources', async () => {
    const { startManualScan } = await import('../worker/check.js');
    let calls = 0;
    const feeds = [{ id: 'one', label: 'One', fetchListings: async () => { calls++; return []; } }];
    await startManualScan(db, feeds);
    await assert.rejects(runCheck(db, feeds, { recovery: true }), CheckInProgressError);
    assert.equal(calls, 0);
    await db.prepare("UPDATE manual_scans SET expires_at = '2000-01-01T00:00:00Z'").run();
    const app = createWorker(feeds);
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    await app.scheduled({ scheduledTime: hour + 60000 }, runtime.env);
    assert.equal(calls, 1);
    await app.scheduled({ scheduledTime: hour + 60000 }, runtime.env);
    assert.equal(calls, 1);
});

test('Unicode and case normalization survives import, search, internship filters, sorting and updates', async () => {
    const jobs = [
        { ...listing, title: 'ＳＯＦＴＷＡＲＥ\u00a0ＥＮＧＩＮＥＥＲ (ＣＯ‑ＯＰ)', company: 'Caf&eacute; Labs', location: 'ＳＡＮ ＪＯＳÉ， ＣＡ', description: '<p>Ｃ＋＋ and PY\u200bTHON</p>' },
        { ...listing, url: 'https://example.com/senior', title: 'Senior Software Engineer', company: 'Café Labs' },
    ];
    const report = await checkSources(db, [source(jobs)]);
    assert.equal(report[0].error, null);
    assert.equal(report[0].inserted, 2);
    const get = async params => {
        const response = await worker.fetch(new Request(`http://localhost/api/jobs?${new URLSearchParams(params)}`), runtime.env);
        assert.equal(response.status, 200);
        return response.json();
    };
    for (const q of ['CAFE\tLABS', 'cafe\u0301 labs', 'ＣＡＦÉ ＬＡＢＳ']) {
        const result = await get({ q, internships: ' TRUE ', sort: ' IMPORTANCE ', view: ' ALL ', skillMode: ' ANY ', skills: '6' });
        assert.equal(result.pagination.total, 1);
        assert.equal(result.jobs[0].skillMask, 6);
        assert.equal(result.jobs[0].company, 'Café Labs');
    }
    const all = await get({ sort: 'importance' });
    assert.equal(all.jobs[0].skillMask, 6);
    const updated = await worker.fetch(new Request(`http://localhost/api/jobs/${all.jobs[0].id}`, {
        method: 'PATCH', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ applicationStatus: ' APPLIED ', notes: '  Keep MY\n formatting.  ' }),
    }), runtime.env);
    assert.equal(updated.status, 200);
    const saved = await updated.json();
    assert.equal(saved.applicationStatus, 'applied');
    assert.equal(saved.notes, '  Keep MY\n formatting.  ');
    await checkSources(db, [source([{ ...jobs[0], title: 'Software Engineer', company: 'Other Corp', description: 'Java' }, jobs[1]])]);
    assert.equal((await get({ q: 'other corp', internships: 'true' })).pagination.total, 0);
    assert.equal((await get({ q: 'other corp' })).pagination.total, 1);
});

test('manual imports build Unicode search keys and retain case-sensitive application URLs', async () => {
    const response = await worker.fetch(new Request('http://localhost/api/jobs/import', {
        method: 'POST', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: ' HTTPS://EXAMPLE.COM/Jobs/AbC?Token=XyZ ', title: '  ＰＹＴＨＯＮ\tＩＮＴＥＲＮ ', company: 'Café', location: 'Remote' }),
    }), runtime.env);
    assert.equal(response.status, 201);
    const result = await (await worker.fetch(new Request('http://localhost/api/jobs?q=python%20intern&internships=true'), runtime.env)).json();
    assert.equal(result.pagination.total, 1);
    assert.equal(result.jobs[0].canonicalUrl, 'https://example.com/Jobs/AbC?Token=XyZ');
    assert.equal(result.jobs[0].skillMask, 2);
});

test('backfill updates legacy search metadata without changing user data and is safe to repeat', async () => {
    const { backfillStatement } = await import('../scripts/backfill-search.js');
    await checkSources(db, [source([{ ...listing, title: 'Software Engineer (ＣＯ‑ＯＰ)', company: "Café O'Neil" }])]);
    await db.prepare("UPDATE jobs SET search_text = NULL, title_key = NULL, is_intern = NULL, notes = 'MY note', application_status = 'applied'").run();
    const rows = (await db.prepare('SELECT id,title,company,location FROM jobs').all()).results;
    await db.prepare(backfillStatement('jobs', rows)).run();
    const row = await db.prepare('SELECT * FROM jobs').first();
    assert.equal(row.search_text, "software engineer co op cafe o neil san jose ca");
    assert.equal(row.is_intern, 1);
    assert.equal(row.notes, 'MY note');
    assert.equal(row.application_status, 'applied');
    assert.equal((await db.prepare(backfillStatement('jobs', rows)).run()).meta.changes, 0);
});
