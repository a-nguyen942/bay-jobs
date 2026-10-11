import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greenhouseSource } from '../worker/sources/greenhouse.js';
const config = { id: 'figma', company: 'Figma', boardToken: 'figma' };
const job = { id: 42, title: 'Software Engineer', location: { name: 'San Francisco, CA' }, absolute_url: 'https://boards.greenhouse.io/figma/jobs/42', updated_at: '2026-01-01T00:00:00Z' };
test('Greenhouse uses the public read endpoint and never treats updated_at as a posting date', async () => {
    const source = greenhouseSource(config, async (input, options) => {
        assert.equal(input, 'https://boards-api.greenhouse.io/v1/boards/figma/jobs?content=true');
        assert.ok(options?.signal);
        assert.equal(options?.method, undefined);
        return Response.json({ jobs: [job] });
    });
    assert.deepEqual(await source.fetchListings(), [{ sourceJobId: '42', title: job.title, company: 'Figma', location: job.location.name, url: job.absolute_url, postedAt: null, description: null }]);
});
test('empty boards succeed but HTTP failures and malformed feeds are errors', async () => {
    assert.deepEqual(await greenhouseSource(config, async () => Response.json({ jobs: [] })).fetchListings(), []);
    await assert.rejects(greenhouseSource(config, async () => new Response(null, { status: 429 })).fetchListings(), /HTTP 429/);
    for (const body of [null, {}, { jobs: 'bad' }, { jobs: [null] }, { jobs: [{ ...job, location: null }] }]) {
        await assert.rejects(greenhouseSource(config, async () => Response.json(body)).fetchListings(), /Greenhouse/);
    }
});

test('internship-only boards fetch descriptions only for technical internships and share a deadline', async () => {
    const intern = { ...job, id: 101, title: 'Software Engineering Intern (2027)' };
    const coop = { ...job, id: 102, title: 'Backend Engineer Co-op' };
    const requests = [], signals = [];
    const source = greenhouseSource({ ...config, internshipsOnly: true }, async (url, options) => {
        requests.push(url); signals.push(options.signal);
        if (url.endsWith('/jobs')) return Response.json({ jobs: [job, intern, coop,
            { ...job, id: 103, title: 'Marketing Intern' }, { ...job, id: 104, title: 'Software Engineer, International' }] });
        return Response.json({ ...(url.endsWith('/101') ? intern : coop), content: '<p>Python and React</p>' });
    });
    const listings = await source.fetchListings();
    assert.deepEqual(listings.map(job => job.sourceJobId), ['101', '102']);
    assert.equal(requests.length, 3);
    assert.ok(requests[0].endsWith('/jobs'));
    assert.ok(signals.every(signal => signal === signals[0]));
    assert.ok(listings.every(job => job.description.includes('Python')));
});

test('internship detail failures, incorrect IDs, missing descriptions and overflow reject the whole feed', async () => {
    const intern = { ...job, title: 'Software Engineer Intern' };
    for (const response of [() => new Response(null, { status: 404 }), () => Response.json({ ...intern, id: 999, content: 'Python' }), () => Response.json(intern)]) {
        const source = greenhouseSource({ ...config, internshipsOnly: true }, async url => url.endsWith('/jobs')
            ? Response.json({ jobs: [intern] }) : response());
        await assert.rejects(source.fetchListings(), /Greenhouse/);
    }
    let calls = 0;
    const source = greenhouseSource({ ...config, internshipsOnly: true }, async () => {
        calls++;
        return Response.json({ jobs: Array.from({ length: 13 }, (_, i) => ({ ...intern, id: i })) });
    });
    await assert.rejects(source.fetchListings(), /12-description limit/);
    assert.equal(calls, 1);
});

test('Greenhouse rejects an index whose advertised total is incomplete', async () => {
    const source = greenhouseSource({ id: 'example', company: 'Example', boardToken: 'example' }, async () => Response.json({ jobs: [], meta: { total: 25 } }));
    await assert.rejects(source.fetchListings(), /incomplete jobs index/);
});
