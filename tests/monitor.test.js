import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { canonicalizeUrl, matchesSearch } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
import { checkSources } from '../worker/monitor.js';
import worker, { createWorker } from '../worker/index.js';
import { runCheck, CheckInProgressError } from '../worker/check.js';
import { greenhouseSource } from '../worker/sources/greenhouse.js';
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
beforeEach(async () => { await db.batch([db.prepare('DELETE FROM jobs'), db.prepare('DELETE FROM source_runs'), db.prepare('DELETE FROM monitor_lock')]); });
const listing = { sourceJobId: '42', title: 'Software Engineer', company: 'Example', location: 'San Jose, CA', url: 'https://job-boards.greenhouse.io/example/jobs/42', postedAt: null };
const source = (jobs, id = 'example') => ({ id, label: id, fetchListings: async () => jobs });
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
    const event = { scheduledTime: Date.now(), cron: '*/30 * * * *', noRetry() { } };
    await app.scheduled(event, runtime.env);
    assert.equal(fetches, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first())?.count, 1);
    await db.prepare('INSERT INTO monitor_lock VALUES (1, ?, ?)').bind('manual', new Date(Date.now() + 60_000).toISOString()).run();
    await app.scheduled(event, runtime.env);
    assert.equal(fetches, 1);
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
