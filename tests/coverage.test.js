import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { checkSources } from '../worker/monitor.js';
import { createWorker } from '../worker/index.js';
import { cleanCoverage, coverageReport, dayBounds, pacificDay } from '../worker/coverage.js';
import { pingWatchdog, validPingUrl } from '../worker/watchdog.js';
import { broadLocation, rejectionReason } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
let runtime, db;
const internship = { title: 'Software Engineer Intern', company: 'Example', location: 'San Jose, CA', url: 'https://example.com/jobs/1', description: 'Python' };
const source = (jobs, id = 'example') => ({ id, label: id, fetchListings: async () => jobs });
const feeds = [source([], 'example'), source([], 'backup')];
const app = createWorker(feeds);
const request = (path, body, origin = 'http://localhost') => app.fetch(new Request(`http://localhost${path}`, body === undefined ? {} : {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), runtime.env);
before(async () => {
    runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false });
    db = runtime.env.DB;
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(part => part.trim()).map(part => db.prepare(part)));
    }
});
after(async () => { await runtime?.dispose(); });
beforeEach(async () => {
    await db.batch(['jobs', 'source_runs', 'source_integrity', 'source_checks', 'filtered_listings', 'search_settings', 'source_feed_cache']
        .map(table => db.prepare(`DELETE FROM ${table}`)));
    await db.prepare('UPDATE watchdog_settings SET ping_url = NULL, last_ping_at = NULL, error = NULL').run();
});
test('rejection reasons distinguish keyword and location exclusions without changing normal matching', () => {
    const reason = rejectionReason({ ...searchPreferences, keywords: ['backend'] });
    assert.equal(reason(internship), 'Required title keyword missing');
    assert.equal(rejectionReason(searchPreferences)({ ...internship, location: 'United States' }), 'Location needs review');
    assert.equal(rejectionReason(searchPreferences)({ ...internship, location: 'Toronto, Canada' }), 'Outside selected locations');
    assert.equal(rejectionReason(searchPreferences)(internship), null);
    for (const location of ['', 'Unspecified', 'US', 'United States', 'Remote - US']) assert.equal(broadLocation({ location }), true);
    assert.equal(broadLocation({ location: 'San Jose, CA' }), false);
});
test('filtered internships persist, paginate and search; saving bypasses discovery without duplicate state or emails', async () => {
    const rejected = Array.from({ length: 28 }, (_, i) => ({ ...internship, url: `https://example.com/jobs/${i}`, location: 'New York, NY' }));
    await checkSources(db, [source([...rejected, { ...internship, url: 'https://example.com/broad', location: 'United States' },
        { ...internship, url: 'https://example.com/senior', title: 'Senior Engineer', location: 'New York, NY' }])]);
    let response = await request('/api/filtered');
    assert.equal(response.status, 200);
    let result = await response.json();
    assert.equal(result.total, 28); assert.equal(result.jobs.length, 25);
    assert.equal((await (await request('/api/filtered?page=2')).json()).jobs.length, 3);
    assert.equal((await (await request('/api/filtered?broad=true')).json()).total, 29);
    assert.equal((await (await request('/api/filtered?q=united&broad=true')).json()).total, 1);
    const candidate = result.jobs[0];
    assert.equal(candidate.reason, 'Outside selected locations');
    const saved = await request('/api/filtered', { id: candidate.id });
    assert.equal(saved.status, 200);
    const job = (await saved.json()).job;
    assert.equal(job.skillMask, 2);
    assert.equal(job.firstFoundAt, candidate.first_found_at);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM job_sources').first()).n, 1);
    assert.equal((await (await request('/api/filtered')).json()).total, 27);
    await checkSources(db, [source(rejected)]);
    assert.equal((await (await request('/api/filtered?broad=true')).json()).total, 28, 'vanished candidates stay available for seven days');
    assert.equal((await request('/api/filtered', { id: 'unknown' }, 'https://foreign.test')).status, 403);
    assert.equal((await request('/api/filtered?page=-1')).status, 400);
    assert.equal((await request('/api/coverage/accept-snapshot')).status, 405);
    // A candidate also discovered by a matching source never appears twice.
    await db.prepare("UPDATE jobs SET application_status = 'applied', notes = 'preserve' WHERE id = ?").bind(job.id).run();
    await checkSources(db, [source([{ ...internship, url: job.canonicalUrl }], 'backup')]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 1);
    assert.equal((await db.prepare('SELECT notes FROM jobs WHERE id = ?').bind(job.id).first()).notes, 'preserve');
});
test('expiry is enforced on reads and maintenance, including old source history', async () => {
    await checkSources(db, [source([{ ...internship, location: 'New York, NY' }])]);
    const candidate = await db.prepare('SELECT id FROM filtered_listings').first();
    const old = new Date(Date.now() - 9 * 86400000).toISOString();
    await db.prepare('UPDATE filtered_listings SET last_seen_at = ?').bind(old).run();
    await db.prepare('UPDATE source_checks SET checked_at = ?').bind(old).run();
    assert.equal((await (await request('/api/filtered')).json()).total, 0);
    assert.equal((await request('/api/filtered', candidate)).status, 404);
    await cleanCoverage(db);
    for (const table of ['filtered_listings', 'source_checks']) assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
});
test('suspicious drops cannot close jobs or replace the accepted baseline; explicit acknowledgement accepts one valid snapshot', async () => {
    const jobs = Array.from({ length: 25 }, (_, i) => ({ ...internship, url: `https://example.com/jobs/${i}` }));
    assert.equal((await checkSources(db, [source(jobs)]))[0].error, null);
    const first = await checkSources(db, [source([])]);
    assert.match(first[0].error, /Suspicious listing drop/);
    await checkSources(db, [source([])], { recovery: true });
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE closed_at IS NOT NULL').first()).n, 0);
    assert.equal((await db.prepare('SELECT accepted_count FROM source_integrity').first()).accepted_count, 25);
    assert.equal((await request('/api/coverage/accept-snapshot', { id: 'example' }, 'https://foreign.test')).status, 403);
    assert.equal((await request('/api/coverage/accept-snapshot', { id: 'example' })).status, 200);
    assert.match((await checkSources(db, [source([{ nope: true }])]))[0].error, /format changed/);
    assert.equal((await checkSources(db, [source([])]))[0].error, null);
    assert.equal((await db.prepare('SELECT allow_next FROM source_integrity').first()).allow_next, 0);
    await checkSources(db, [source([])]);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE closed_at IS NOT NULL').first()).n, 25);
    assert.equal((await request('/api/coverage/accept-snapshot', { id: 'example' })).status, 409);
});
test('coverage reports source failures, recovered checks, discoveries and overlapping sources', async () => {
    await checkSources(db, [source([internship])]);
    await checkSources(db, [{ id: 'backup', label: 'backup', fetchListings: async () => { throw new Error('Offline'); } }]);
    await checkSources(db, [source([internship], 'backup')], { recovery: true });
    const report = await coverageReport(db, feeds);
    assert.equal(report.checked, 2); assert.equal(report.overdue.length, 0);
    assert.equal(report.totals.attempts, 3); assert.equal(report.totals.failures, 1);
    assert.equal(report.totals.recovered, 1); assert.equal(report.totals.discovered, 1);
    assert.equal(report.overlap, 1);
    assert.equal((await request('/api/coverage?day=2000-01-01')).status, 400);
    assert.equal((await request('/api/coverage?day=2026-02-30')).status, 400);
    assert.equal((await request('/api/coverage')).status, 200);
    assert.equal((await request('/api/coverage', { id: 'example' })).status, 405);
});
test('Pacific report bounds include full spring and fall transition days', () => {
    for (const [day, hours] of [['2026-03-08', 23], ['2026-11-01', 25], ['2026-09-16', 24]]) {
        const [start, end] = dayBounds(day);
        assert.equal((Date.parse(end) - Date.parse(start)) / 3600000, hours);
        assert.equal(pacificDay(start), day);
        assert.equal(pacificDay(Date.parse(end) - 1), day);
    }
});
test('watchdog requires a complete current-hour scan, limits heartbeats, and never exposes its secret URL', async () => {
    const pingUrl = 'https://hc-ping.com/11111111-1111-1111-1111-111111111111';
    const setup = await request('/api/watchdog', { pingUrl });
    assert.equal(setup.status, 200);
    assert.equal((await setup.json()).configured, true);
    assert.ok(!(await (await request('/api/watchdog')).text()).includes(pingUrl));
    let calls = 0;
    const ping = async (url, options) => { calls++; assert.equal(url, pingUrl); assert.equal(options.redirect, 'error'); return new Response('OK'); };
    await pingWatchdog(db, feeds, Date.now(), ping); assert.equal(calls, 0);
    await checkSources(db, [source([internship])]);
    await pingWatchdog(db, feeds, Date.now(), ping); assert.equal(calls, 0);
    await checkSources(db, [source([internship], 'backup')]);
    await pingWatchdog(db, feeds, Date.now(), ping); assert.equal(calls, 1);
    await pingWatchdog(db, feeds, Date.now(), ping); assert.equal(calls, 1);
    assert.ok((await (await request('/api/watchdog')).json()).lastPingAt);
    assert.equal((await request('/api/watchdog', { pingUrl }, 'https://foreign.test')).status, 403);
    for (const bad of ['https://example.com/secret', 'http://hc-ping.com/11111111-1111-1111-1111-111111111111', pingUrl + '/fail', pingUrl + '?x=1', 'http://127.0.0.1']) {
        assert.equal(validPingUrl(bad), false);
        assert.equal((await request('/api/watchdog', { pingUrl: bad })).status, 400);
    }
    await request('/api/watchdog', { pingUrl });
    await pingWatchdog(db, feeds, Date.now(), async () => { throw new Error(`sensitive ${pingUrl}`); });
    const failed = await (await request('/api/watchdog')).json();
    assert.equal(failed.lastPingAt, null); assert.ok(failed.error); assert.ok(!failed.error.includes(pingUrl));
    await request('/api/watchdog', { pingUrl: null });
    assert.equal((await (await request('/api/watchdog')).json()).configured, false);
});

test('unchanged review candidates avoid hourly writes and cache refreshes do not revive vanished candidates', async () => {
    let unchanged = false;
    let jobs = [{ ...internship, location: 'New York, NY' }];
    const feed = { id: 'example', label: 'example', cacheKey: 'v1', fetchListings: async ({ onResponse }) => {
        onResponse('"v1"'); return unchanged ? null : jobs;
    } };
    await checkSources(db, [feed]);
    const candidate = await db.prepare('SELECT * FROM filtered_listings').first();
    await db.prepare("CREATE TRIGGER no_redundant_review_write BEFORE UPDATE ON filtered_listings BEGIN SELECT RAISE(ABORT, 'redundant review write'); END").run();
    try {
        assert.equal((await checkSources(db, [feed]))[0].error, null);
        unchanged = true;
        assert.equal((await checkSources(db, [feed]))[0].error, null);
    } finally { await db.prepare('DROP TRIGGER no_redundant_review_write').run(); }
    unchanged = false; jobs = [];
    await checkSources(db, [feed]);
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    await db.prepare('UPDATE filtered_listings SET last_seen_at = ?').bind(yesterday).run();
    unchanged = true;
    await checkSources(db, [feed]);
    assert.equal((await db.prepare('SELECT last_seen_at FROM filtered_listings WHERE id = ?').bind(candidate.id).first()).last_seen_at, yesterday);
});

test('upgraded sources use their committed feed as the first integrity baseline', async () => {
    let jobs = Array.from({ length: 6 }, (_, i) => ({ ...internship, url: `https://example.com/${i}` }));
    const feed = { id: 'example', label: 'example', cacheKey: 'existing-source', fetchListings: async () => jobs };
    await checkSources(db, [feed]);
    await db.prepare('DELETE FROM source_integrity').run();
    jobs = [];
    assert.match((await checkSources(db, [feed]))[0].error, /Suspicious listing drop/);
    const state = await db.prepare('SELECT accepted_count, warning FROM source_integrity').first();
    assert.equal(state.accepted_count, 6); assert.ok(state.warning);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE closed_at IS NOT NULL').first()).n, 0);
});

test('review search and promotion share normalized text and internship classification', async () => {
    await checkSources(db, [source([{ ...internship, title: 'Software Engineer (ＣＯ‑ＯＰ)', company: 'Caf&eacute; Labs', location: 'NEW\u00a0YORK, NY' }])]);
    const response = await request('/api/filtered?q=CAFE%20%20LABS&broad=%20FALSE%20');
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 1);
    assert.equal((await request('/api/filtered', { id: result.jobs[0].id })).status, 200);
    const saved = await (await request('/api/jobs?q=cafe%20labs&internships=true')).json();
    assert.equal(saved.pagination.total, 1);
});
