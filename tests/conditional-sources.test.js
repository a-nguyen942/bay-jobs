import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSources } from '../worker/sources/index.js';

for (const config of [
    { id: 'greenhouse', kind: 'greenhouse', company: 'Example', boardToken: 'example' },
    { id: 'ashby', kind: 'ashby', company: 'Example', boardToken: 'example' },
    { id: 'github', kind: 'github', owner: 'Example', repo: 'Jobs', branch: 'main', format: 'speedy' },
]) {
    test(`${config.kind} skips parsing a 304 only when a validator was supplied`, async () => {
        let validator;
        const source = createSources([config], async (_url, options) => {
            validator = new Headers(options.headers).get('If-None-Match');
            return new Response(null, { status: 304 });
        })[0];
        assert.equal(await source.fetchListings({ etag: '"saved"' }), null);
        assert.equal(validator, '"saved"');
        await assert.rejects(source.fetchListings(), /without a saved validator/);
    });
}

test('internship details neither reuse nor overwrite the index validator; 304 skips details', async () => {
    const config = { id: 'interns', kind: 'greenhouse', company: 'Example', boardToken: 'example', internshipsOnly: true };
    const intern = { id: 1, title: 'Software Engineer Intern', absolute_url: 'https://example.com/jobs/1', location: { name: 'San Jose, CA' } };
    const validators = [];
    let saved;
    let unchanged = false;
    const source = createSources([config], async (url, options) => {
        validators.push(new Headers(options.headers).get('If-None-Match'));
        if (url.endsWith('/jobs')) return unchanged ? new Response(null, { status: 304 })
            : Response.json({ jobs: [intern] }, { headers: { ETag: '"index"' } });
        return Response.json({ ...intern, content: 'Python' }, { headers: { ETag: '"detail"' } });
    })[0];
    assert.equal((await source.fetchListings({ etag: '"old"', onResponse: value => { saved = value; } })).length, 1);
    assert.deepEqual(validators, ['"old"', null]);
    assert.equal(saved, '"index"');
    unchanged = true;
    assert.equal(await source.fetchListings({ etag: saved }), null);
    assert.equal(validators.length, 3);
});
