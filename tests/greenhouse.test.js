import assert from 'node:assert/strict';
import { test } from 'node:test';
import { greenhouseSource } from '../worker/sources/greenhouse.js';
const config = { id: 'figma', company: 'Figma', boardToken: 'figma' };
const job = { id: 42, title: 'Software Engineer', location: { name: 'San Francisco, CA' }, absolute_url: 'https://boards.greenhouse.io/figma/jobs/42', updated_at: '2026-01-01T00:00:00Z' };
test('Greenhouse uses the public read endpoint and never treats updated_at as a posting date', async () => {
    const source = greenhouseSource(config, async (input, options) => {
        assert.equal(input, 'https://boards-api.greenhouse.io/v1/boards/figma/jobs');
        assert.ok(options?.signal);
        assert.equal(options?.method, undefined);
        return Response.json({ jobs: [job] });
    });
    assert.deepEqual(await source.fetchListings(), [{ sourceJobId: '42', title: job.title, company: 'Figma', location: job.location.name, url: job.absolute_url, postedAt: null }]);
});
test('empty boards succeed but HTTP failures and malformed feeds are errors', async () => {
    assert.deepEqual(await greenhouseSource(config, async () => Response.json({ jobs: [] })).fetchListings(), []);
    await assert.rejects(greenhouseSource(config, async () => new Response(null, { status: 429 })).fetchListings(), /HTTP 429/);
    for (const body of [null, {}, { jobs: 'bad' }, { jobs: [null] }, { jobs: [{ ...job, location: null }] }]) {
        await assert.rejects(greenhouseSource(config, async () => Response.json(body)).fetchListings(), /Greenhouse/);
    }
});
