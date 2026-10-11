import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { aggregatorSources, aggregatorStatus, parseAggregator, runAggregators, AGGREGATOR_INTERVAL } from '../worker/aggregators.js';
import { checkSources } from '../worker/monitor.js';
let runtime, db;
const sample = { title: 'Software Engineer Intern', company_name: 'Example', location: 'San Jose, CA', job_id: 'a', apply_options: [{ link: 'https://example.com/jobs/1' }] };
before(async () => {
    runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false }); db = runtime.env.DB;
    const directory = new URL('../drizzle/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(name, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(part => part.trim()).map(part => db.prepare(part)));
    }
});
after(async () => runtime?.dispose());
beforeEach(async () => {
    await db.batch(['jobs', 'source_runs', 'source_integrity', 'source_checks', 'filtered_listings', 'search_settings', 'source_feed_cache', 'aggregator_budget', 'monitor_lock']
        .map(table => db.prepare(`DELETE FROM ${table}`)));
});
const environment = () => ({ DB: db, FREE_AGGREGATOR_IMPORTS: 'true', SERPAPI_API_KEY: 'fake-secret' });
test('API integrations are opt-in and status never includes credentials', async () => {
    assert.equal(aggregatorSources({}).length, 0);
    assert.equal(aggregatorSources({ SERPAPI_API_KEY: 'fake-secret' }).length, 0);
    assert.equal(aggregatorSources(environment()).length, 2);
    const status = await aggregatorStatus(environment());
    assert.equal(status.find(row => row.id === 'google-jobs').enabled, true);
    assert.equal(status.find(row => row.id === 'adzuna').enabled, false);
    assert.ok(!JSON.stringify(status).includes('fake-secret'));
});
test('daily reservation is atomic and failed requests consume the allowance without leaking keyed URLs', async () => {
    let requests = 0;
    const now = 1800000000000;
    const source = aggregatorSources(environment(), async url => { requests++; throw new Error(url); }, () => now).find(source => source.id === 'google-jobs');
    const results = await Promise.allSettled([source.fetchListings(), source.fetchListings()]);
    assert.equal(requests, 1);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.ok(results.every(result => !result.reason.message.includes('fake-secret')));
    assert.equal((await db.prepare('SELECT next_allowed_at FROM aggregator_budget').first()).next_allowed_at, now + AGGREGATOR_INTERVAL);
    await aggregatorSources(environment(), async () => Response.json({ jobs_results: [sample] }), () => now + AGGREGATOR_INTERVAL).find(source => source.id === 'google-jobs').fetchListings();
});
test('scheduled discovery skips providers until due and never paginates', async () => {
    let requests = 0;
    const request = async url => {
        requests++;
        const parsed = new URL(url);
        assert.equal(parsed.hostname, 'serpapi.com');
        if (parsed.searchParams.get('engine') === 'google') {
            assert.match(parsed.searchParams.get('q'), /site:linkedin.com\/jobs\/view/);
            return Response.json({ organic_results: [] });
        }
        assert.equal(parsed.searchParams.get('engine'), 'google_jobs');
        return Response.json({ jobs_results: [sample], serpapi_pagination: { next: 'https://untrusted.test/' } });
    };
    await runAggregators(environment(), request);
    await runAggregators(environment(), request);
    assert.equal(requests, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_events').first()).n, 0);
});
test('search samples never mark missing jobs closed or reject a normal drop in results', async () => {
    let rows = parseAggregator('google-jobs', { jobs_results: [sample] });
    const source = { id: 'search', label: 'Search', discoveryOnly: true, fetchListings: async () => rows };
    await checkSources(db, [source]); rows = [];
    await checkSources(db, [source]); await checkSources(db, [source]);
    assert.equal((await db.prepare('SELECT closed_at FROM jobs').first()).closed_at, null);
    assert.equal((await db.prepare('SELECT missing_count FROM job_sources').first()).missing_count, 0);
});
test('parsers preserve apply URLs and reject invalid responses rather than invent listings', () => {
    assert.equal(parseAggregator('google-jobs', { jobs_results: [sample] })[0].url, sample.apply_options[0].link);
    assert.equal(parseAggregator('adzuna', { results: [{ id: 'x', title: sample.title, company: { display_name: 'Example' }, location: { display_name: sample.location }, redirect_url: 'https://www.adzuna.com/details/x' }] })[0].company, 'Example');
    for (const body of [{ error: 'bad' }, { jobs_results: [{}] }, { jobs_results: [{ ...sample, apply_options: [{ link: 'javascript:alert(1)' }] }] }])
        assert.throws(() => parseAggregator('google-jobs', body));
});
