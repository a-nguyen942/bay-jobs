import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeHTML } from 'entities';
import { parseWellfound, parseYC, publicBoardSource } from '../worker/sources/public-boards.js';
import { parseLinkedinIndex, linkedinJobUrl } from '../worker/sources/linkedin-index.js';
import { createSources } from '../worker/sources/index.js';

const ycRow = { id: 1, title: 'Software Engineer Intern', companyName: 'Example', location: 'San Francisco, CA, US', type: 'Internship', url: '/companies/example/jobs/abc-intern' };
const ycPage = rows => `<div data-page="${encodeHTML(JSON.stringify({ props: { jobPostings: rows } }))}"></div>`;
function wellfoundData() {
    return { props: { pageProps: { location: 'san-jose', role: 'software-engineer', apolloState: { data: {
        ROOT_QUERY: { talent: { 'seoLandingPageJobSearchResults({"location":"san-jose","page":1,"role":"software-engineer"})': { totalJobCount: 5, startups: [{ __ref: 'StartupResult:1' }] } } },
        'StartupResult:1': { name: 'Example', highlightedJobListings: [{ __ref: 'JobListingSearchResult:2' }] },
        'JobListingSearchResult:2': { id: '2', slug: 'software-intern', title: 'Software Intern', locationNames: ['San Jose', 'New York City'], remote: true, remoteConfig: { kind: 'REMOTE' }, jobType: 'internship', description: 'Use Python' },
    } } } } };
}
const wellfoundPage = data => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;

test('YC public data preserves explicit locations, stable listing links and internship flags', () => {
    const rows = parseYC(ycPage([ycRow]));
    assert.equal(rows[0].url, 'https://www.ycombinator.com/companies/example/jobs/abc-intern');
    assert.equal(rows[0].isIntern, true);
    assert.equal(rows[0].postedAt, null);
    assert.deepEqual(parseYC(ycPage([])), []);
    for (const html of ['<h1>Sign in</h1>', ycPage([{ ...ycRow, url: 'https://evil.example/jobs/1' }]), ycPage([{ ...ycRow, companyName: null }])]) assert.throws(() => parseYC(html));
});
test('Wellfound resolves company references and qualifies only the selected California city', () => {
    const rows = parseWellfound(wellfoundPage(wellfoundData()), 'san-jose');
    assert.equal(rows[0].company, 'Example');
    assert.equal(rows[0].url, 'https://wellfound.com/jobs/2-software-intern');
    assert.equal(rows[0].location, 'San Jose, CA; New York City; Remote');
    assert.equal(rows[0].description, 'Use Python');
    assert.equal(rows[0].isRemoteOnly, true);
    assert.equal(rows[0].isIntern, true);
});
test('Wellfound rejects wrong searches, missing references and challenge pages', () => {
    const data = wellfoundData();
    assert.throws(() => parseWellfound(wellfoundPage(data), 'san-francisco'));
    delete data.props.pageProps.apolloState.data['JobListingSearchResult:2'];
    assert.throws(() => parseWellfound(wellfoundPage(data), 'san-jose'));
    assert.throws(() => parseWellfound('<h1>Verify your browser</h1>', 'san-jose'));
});
test('public-board adapters route through source factory and fail closed on blocked or oversized responses', async () => {
    const configs = [{ id: 'yc', kind: 'yc' }, { id: 'wf', kind: 'wellfound', city: 'san-jose' }];
    const seen = [];
    const sources = createSources(configs, async (url, options) => {
        seen.push(url); assert.equal(options.redirect, 'manual'); assert.ok(options.signal);
        return new Response(url.includes('ycombinator') ? ycPage([ycRow]) : wellfoundPage(wellfoundData()));
    });
    for (const source of sources) { assert.equal(source.discoveryOnly, true); assert.equal((await source.fetchListings()).length, 1); }
    assert.ok(seen[1].endsWith('/role/l/software-engineer/san-jose'));
    await assert.rejects(publicBoardSource(configs[0], async () => new Response('', { status: 403 })).fetchListings(), /HTTP 403/);
    await assert.rejects(publicBoardSource(configs[0], async () => new Response('', { headers: { 'content-length': '3000000' } })).fetchListings(), /safety limit/);
});
test('LinkedIn search parses both known title formats without inventing missing locations', () => {
    const rows = parseLinkedinIndex({ organic_results: [
        { link: 'https://www.linkedin.com/jobs/view/software-intern-at-example-123?trackingId=x', title: 'Example hiring Software Intern in San Jose, CA | LinkedIn', snippet: 'Python' },
        { link: 'https://us.linkedin.com/jobs/view/456', title: 'Software Intern at Other — San Francisco, CA | LinkedIn Jobs' },
        { link: 'https://www.linkedin.com/jobs/view/789', title: 'Truncated role…' },
        { link: 'https://www.linkedin.com/jobs/search', title: 'Search results' },
        { link: 'https://evil.example/jobs/view/123', title: 'Example hiring Intern in San Jose, CA' },
    ] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].url, 'https://www.linkedin.com/jobs/view/123');
    assert.equal(rows[0].company, 'Example'); assert.equal(rows[1].location, 'San Francisco, CA');
    assert.equal(rows[1].company, 'Other');
    assert.throws(() => parseLinkedinIndex({ organic_results: [{ link: 'https://linkedin.com/jobs/view/123', title: 'Software Intern' }] }), /lacked complete/);
    assert.throws(() => linkedinJobUrl('https://linkedin.com.evil.example/jobs/view/123'));
    assert.deepEqual(parseLinkedinIndex({ organic_results: [] }), []);
});
