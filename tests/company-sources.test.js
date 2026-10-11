import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ashbySource } from '../worker/sources/ashby.js';
import { leverSource } from '../worker/sources/lever.js';
import { createSources } from '../worker/sources/index.js';
import { matchesSearch } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';

const config = { id: 'example', company: 'Example', boardToken: 'example' };
const ashbyJob = { title: 'Software Engineer', location: 'New York, NY', isListed: true,
    secondaryLocations: [{ location: 'San Francisco, CA' }], isRemote: true, workplaceType: 'Hybrid',
    jobUrl: 'https://jobs.ashbyhq.com/example/123?utm_source=board', publishedAt: '2026-09-01T12:00:00Z' };
const leverJob = { id: '123', text: 'Software Engineer', categories: { location: 'New York, NY', allLocations: ['New York, NY', 'San Jose, CA'] },
    hostedUrl: 'https://jobs.lever.co/example/123', createdAt: 1700000000000, workplaceType: 'hybrid' };

test('Ashby uses the public endpoint, includes secondary locations, and skips unlisted postings', async () => {
    const source = ashbySource(config, async (url, options) => {
        assert.equal(url, 'https://api.ashbyhq.com/posting-api/job-board/example');
        assert.ok(options.signal);
        assert.equal(options.headers.Authorization, undefined);
        return Response.json({ jobs: [ashbyJob, { isListed: false }] });
    });
    const jobs = await source.fetchListings();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].location, 'New York, NY; San Francisco, CA');
    assert.equal(jobs[0].url, 'https://jobs.ashbyhq.com/example/123');
    assert.equal(jobs[0].postedAt, null);
    assert.equal(jobs[0].isRemoteOnly, false);
    assert.equal(matchesSearch(jobs[0], searchPreferences), true);
});

test('Ashby rejects malformed and failed responses without treating them as empty feeds', async () => {
    assert.deepEqual(await ashbySource(config, async () => Response.json({ jobs: [] })).fetchListings(), []);
    for (const body of [null, {}, { jobs: [null] }, { jobs: [{ ...ashbyJob, isListed: undefined }] },
        { jobs: [{ ...ashbyJob, secondaryLocations: [{ location: 42 }] }] }, { jobs: [{ ...ashbyJob, jobUrl: 'javascript:alert(1)' }] }])
        await assert.rejects(ashbySource(config, async () => Response.json(body)).fetchListings());
    await assert.rejects(ashbySource(config, async () => new Response(null, { status: 429 })).fetchListings(), /HTTP 429/);
    await assert.rejects(ashbySource({ ...config, boardToken: '../bad' }, () => { throw new Error('must not fetch'); }).fetchListings(), /token/);
});

test('remote-only source flags exclude Bay Area listings while hybrid roles remain eligible', async () => {
    for (const variant of [{ ...ashbyJob, workplaceType: 'Remote' }, { ...ashbyJob, workplaceType: undefined }]) {
        const [job] = await ashbySource(config, async () => Response.json({ jobs: [variant] })).fetchListings();
        assert.equal(matchesSearch(job, searchPreferences), false);
        assert.equal(matchesSearch(job, { ...searchPreferences, includeRemote: true }), true);
    }
    const [job] = await leverSource(config, async () => Response.json([{ ...leverJob, workplaceType: 'remote' }])).fetchListings();
    assert.equal(matchesSearch(job, searchPreferences), false);
    assert.equal(matchesSearch({ ...job, location: 'United States' }, { ...searchPreferences, includeRemote: true }), true);
});

test('Lever follows every page and preserves locations without converting creation dates into posting dates', async () => {
    const requests = [];
    let deadline;
    const source = leverSource(config, async (url, options) => {
        requests.push(url);
        if (!deadline) deadline = options.signal;
        assert.equal(options.signal, deadline);
        assert.equal(options.headers.Authorization, undefined);
        return Response.json(requests.length === 1
            ? Array.from({ length: 100 }, (_, index) => ({ ...leverJob, id: String(index), hostedUrl: `https://jobs.lever.co/example/${index}` }))
            : [{ ...leverJob, id: 'last', hostedUrl: 'https://jobs.lever.co/example/last' }]);
    });
    const jobs = await source.fetchListings();
    assert.equal(jobs.length, 101);
    assert.equal(jobs.at(-1).sourceJobId, 'last');
    assert.equal(jobs[0].location, 'New York, NY; San Jose, CA');
    assert.equal(jobs[0].postedAt, null);
    assert.equal(matchesSearch(jobs[0], searchPreferences), true);
    assert.deepEqual(requests, ['https://api.lever.co/v0/postings/example?mode=json&limit=100&skip=0',
        'https://api.lever.co/v0/postings/example?mode=json&limit=100&skip=100']);
});

test('Lever rejects later-page failures and repeated pages instead of returning partial feeds', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...leverJob, id: String(i) }));
    let calls = 0;
    await assert.rejects(leverSource(config, async () => ++calls === 1 ? Response.json(page) : new Response(null, { status: 503 })).fetchListings(), /HTTP 503/);
    await assert.rejects(leverSource(config, async () => Response.json(page)).fetchListings(), /repeated/);
    calls = 0;
    await assert.rejects(leverSource(config, async () => {
        const pageNumber = calls++;
        return Response.json(page.map((job, i) => ({ ...job, id: `${pageNumber}-${i}` })));
    }).fetchListings(), /20-page limit/);
    assert.equal(calls, 20);
});

test('Lever supports EU feeds and validates configuration, locations, links, and response shape', async () => {
    const jobs = await leverSource({ ...config, region: 'eu' }, async url => {
        assert.match(url, /^https:\/\/api.eu.lever.co\//);
        return Response.json([]);
    }).fetchListings();
    assert.deepEqual(jobs, []);
    for (const body of [{ jobs: [] }, [null], [{ ...leverJob, categories: null }],
        [{ ...leverJob, categories: { location: 'San Jose, CA', allLocations: [null] } }],
        [{ ...leverJob, hostedUrl: 'https://user:password@example.com/jobs/1' }]])
        await assert.rejects(leverSource(config, async () => Response.json(body)).fetchListings());
    for (const invalid of [{ ...config, region: 'bad' }, { ...config, boardToken: '../bad' }])
        await assert.rejects(leverSource(invalid, () => { throw new Error('must not fetch'); }).fetchListings(), /Invalid Lever/);
});

test('configured Ashby and Lever boards route through their own adapters', async () => {
    const sources = createSources([{ ...config, kind: 'ashby' }, { ...config, kind: 'lever' }], async url =>
        Response.json(url.includes('ashbyhq') ? { jobs: [ashbyJob] } : [leverJob]));
    assert.equal(sources[0].label, 'Example · Ashby');
    assert.equal(sources[1].label, 'Example · Lever');
    assert.equal((await sources[0].fetchListings()).length, 1);
    assert.equal((await sources[1].fetchListings()).length, 1);
});
