import assert from 'node:assert/strict';
import { test } from 'node:test';
import { githubSource, parseJsonListings, parseSpeedyTable } from '../worker/sources/github.js';
import { createSources } from '../worker/sources/index.js';

const config = { id: 'github-example', kind: 'github', owner: 'SimplifyJobs', repo: 'Summer2027-Internships', branch: 'dev', format: 'simplify', term: 'Summer 2027' };
const job = { id: 'abc', company_name: 'Example', title: 'Software Engineer Intern', url: 'https://boards.greenhouse.io/example/jobs/42?utm_source=github', locations: ['New York, NY', 'San Jose, CA'], active: true, is_visible: true, category: 'Software Engineering', terms: ['Summer 2027'], date_posted: 1800000000 };
const header = '| Company | Position | Location | Salary | Posting | Age |\n|---|---|---|---|---|---|';
const row = '| <a href="https://example.com"><strong>Example &amp; Co</strong></a> | Software Engineer Intern | San Jose, CA<br>New York, NY | $50/hr | <a href="https://example.com/jobs/1?a=1&amp;b=2"><img alt="Apply"></a> | 1d |';

test('Simplify imports only visible active summer software roles and preserves all locations', () => {
    const jobs = parseJsonListings([job, { ...job, active: false }, { ...job, is_visible: false },
        { ...job, category: 'Hardware Engineering' }, { ...job, terms: ['Summer 2026'] }], config);
    assert.deepEqual(jobs, [{ sourceJobId: 'abc', title: job.title, company: 'Example',
        location: 'New York, NY; San Jose, CA', url: 'https://job-boards.greenhouse.io/example/jobs/42', postedAt: null }]);
});

test('Vansh follows the main summer list and excludes inactive and off-season rows', () => {
    const jobs = parseJsonListings([{ ...job, season: 'Summer' }, { ...job, season: 'Winter' },
        { ...job, season: 'Summer', active: false }], { format: 'vansh' });
    assert.equal(jobs.length, 1);
});

test('structured repository format failures surface instead of silently establishing an empty baseline', () => {
    for (const body of [{ jobs: [] }, [null], [{ ...job, active: 'true' }], [{ ...job, terms: null }],
        [{ ...job, locations: [] }], [{ ...job, url: 'javascript:alert(1)' }]])
        assert.throws(() => parseJsonListings(body, config));
    assert.deepEqual(parseJsonListings([], config), []);
});

test('SpeedyApply reads both table layouts, text entities, and application links without inventing posting dates', () => {
    const jobs = parseSpeedyTable(`${header}\n${row}\n\n### Other\n| Company | Position | Location | Posting | Age |\n|---|---|---|---|---|\n| Other | Software Intern | San Francisco, CA +2 | [Apply](https://example.com/jobs/2) | 2d |`);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].company, 'Example & Co');
    assert.equal(jobs[0].location, 'San Jose, CA; New York, NY');
    assert.equal(jobs[0].url, 'https://example.com/jobs/1?a=1&b=2');
    assert.equal(jobs[0].postedAt, null);
    assert.equal(jobs[1].url, 'https://example.com/jobs/2');
});

test('SpeedyApply skips closed rows, carries company continuations, and rejects broken or missing job tables', () => {
    const jobs = parseSpeedyTable(`${header}\n${row}\n| ↳ | Software Intern | San Jose, CA | - | [Apply](https://example.com/jobs/2) | 1d |\n| Closed | Software Intern | San Jose, CA | - | 🔒 | 3d |`);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[1].company, 'Example & Co');
    assert.deepEqual(parseSpeedyTable(header), []);
    for (const text of ['# No jobs table', `${header}\n| Broken | row |`, `${header}\n${row.replace('https://example.com/jobs/1?a=1&amp;b=2', 'javascript:alert(1)')}`,
        '| Company | Position | Location | Apply | Age |']) assert.throws(() => parseSpeedyTable(text));
});

test('GitHub adapters fetch the configured raw file without credentials and bound failures', async () => {
    const source = githubSource(config, async (url, options) => {
        assert.equal(url, 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json');
        assert.ok(options.signal);
        assert.equal(options.headers.Authorization, undefined);
        return Response.json([job]);
    });
    assert.equal((await source.fetchListings()).length, 1);
    await assert.rejects(githubSource(config, async () => new Response(null, { status: 429 })).fetchListings(), /HTTP 429/);
    await assert.rejects(githubSource(config, async () => new Response('[]', { headers: { 'Content-Length': String(21 * 1024 * 1024) } })).fetchListings(), /safety limit/);
    await assert.rejects(githubSource({ ...config, branch: '../bad' }, () => { throw new Error('must not fetch'); }).fetchListings(), /configuration/);
});

test('source factory routes Greenhouse and GitHub configs to their own adapters', async () => {
    const urls = [];
    const sources = createSources([{ id: 'example', kind: 'greenhouse', company: 'Example', boardToken: 'example' }, config,
        { ...config, id: 'speedy', format: 'speedy' }, { id: 'unknown', kind: 'bad' }], async url => {
        urls.push(url);
        return url.endsWith('README.md') ? new Response(`${header}\n${row}`)
            : url.includes('raw.githubusercontent.com') ? Response.json([job]) : Response.json({ jobs: [] });
    });
    assert.deepEqual(await sources[0].fetchListings(), []);
    assert.equal((await sources[1].fetchListings()).length, 1);
    assert.equal((await sources[2].fetchListings()).length, 1);
    await assert.rejects(sources[3].fetchListings(), /Unsupported/);
    assert.match(urls[0], /boards-api.greenhouse.io/);
    assert.match(urls[2], /README.md$/);
});

test('repository categories, terms, seasons and table headings tolerate case and spacing', () => {
    assert.equal(parseJsonListings([{ ...job, category: ' SOFTWARE\tENGINEERING ', terms: ['ＳＵＭＭＥＲ ２０２７'] }], config).length, 1);
    assert.equal(parseJsonListings([{ ...job, season: ' sUmMeR ' }], { format: 'vansh' }).length, 1);
    assert.equal(parseSpeedyTable(`${header.toUpperCase()}\n${row}`).length, 1);
});

test('new-grad feed has no season requirement and selects active software/data categories', () => {
    const graduate = { ...job, title: 'Software Engineer, New Grad', terms: undefined };
    const rows = parseJsonListings([graduate, { ...graduate, category: 'AI/ML/Data' },
        { ...graduate, active: false }, { ...graduate, is_visible: false }, { ...graduate, category: 'Product' }], { format: 'simplify-newgrad' });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].title, graduate.title);
    assert.throws(() => parseJsonListings([{ ...graduate, category: null }], { format: 'simplify-newgrad' }));
});
