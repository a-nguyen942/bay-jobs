import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesSearch, canonicalizeUrl } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
test('California matches require the state next to a complete Bay Area city name', () => {
    const cases = [
        ['San Jose, CA', true], ['San José, California, USA', true], ['Oakland, CA (Hybrid)', true],
        ['Newark, California', true], ['Fremont CA', true], ['San Francisco, CA • New York, NY • United States', true],
        ['New York, NY; San Mateo, CA', true], ['San Francisco, California, United States', true],
        ['Newark, NJ', false], ['Fremont, NE', false], ['San José, Costa Rica', false],
        ['San Jose, CA, Costa Rica', false], ['Newark', false], ['San Jose, Canada', false],
        ['Newark, NJ; Los Angeles, CA', false], ['Newark, NJ, Los Angeles, CA', false],
        ['Berkeleyshire, CA', false], ['Remote, US', false], ['San Francisco', false],
    ];
    for (const [location, expected] of cases)
        assert.equal(matchesSearch({ title: 'Software Engineer', location }, searchPreferences), expected, location);
});
test('technical roles match while sales, business development, and developer relations do not', () => {
    const included = ['Software Engineer I', 'Software Engineering Intern', 'Senior SWE', 'Backend Engineer', 'Front-End Developer', 'Full Stack Engineer', 'Software Developer', 'Data Engineer', 'Machine Learning Engineer', 'ML Research Scientist', 'Site Reliability Engineer', 'DevOps Engineer', 'Security Engineer', 'QA Engineer', 'iOS Engineer', 'Forward Deployed Engineer', 'Manager, Software Engineering - Billing'];
    const excluded = ['Business Developer', 'Software Sales Representative', 'Developer Relations Manager', 'Developer Advocate', 'Product Manager, Developer Platform', 'Account Executive, Software', 'Recruiter - Software Engineering', 'Marketing Engineer', 'Mechanical Engineer', 'Sales Engineer', 'Technical Writer, Software Engineering'];
    for (const title of included)
        assert.equal(matchesSearch({ title, location: 'San Jose, CA' }, searchPreferences), true, title);
    for (const title of excluded)
        assert.equal(matchesSearch({ title, location: 'San Jose, CA' }, searchPreferences), false, title);
});
test('remote is opt-in and custom stateful patterns do not alternate matches', () => {
    const preferences = { ...searchPreferences, includeRemote: true, rolePattern: /software engineer/gi };
    for (let i = 0; i < 3; i++)
        assert.equal(matchesSearch({ title: 'Software Engineer', location: 'Remote, US' }, preferences), true);
    assert.equal(matchesSearch({ title: 'Software Sales', location: 'Remote, US' }, { ...searchPreferences, includeRemote: true }), false);
});
test('unknown URL routes and identity-like query parameters are preserved', () => {
    for (const [first, second] of [
        ['https://example.com/#/jobs/123', 'https://example.com/#/jobs/456'],
        ['https://example.com/#job=123', 'https://example.com/#job=456'],
        ['https://example.com/apply?ref=123', 'https://example.com/apply?ref=456'],
        ['https://example.com/apply?source=123', 'https://example.com/apply?source=456'],
        ['https://example.com/jobs/123', 'https://example.com/jobs/123/'],
    ])
        assert.notEqual(canonicalizeUrl(first), canonicalizeUrl(second));
    assert.equal(canonicalizeUrl('https://example.com/#/jobs/123?utm_source=github'), 'https://example.com/#/jobs/123?utm_source=github');
    assert.equal(canonicalizeUrl('https://example.com/job?job=123&utm_source=github#apply'), 'https://example.com/job?job=123#apply');
});
test('Greenhouse aliases and tracking merge only when the job identity agrees', () => {
    const expected = 'https://job-boards.greenhouse.io/figma/jobs/123';
    assert.equal(canonicalizeUrl('https://boards.greenhouse.io/figma/jobs/123/?gh_jid=123&gh_src=abc&utm_medium=email#apply'), expected);
    assert.notEqual(canonicalizeUrl('https://boards.greenhouse.io/figma/jobs/123?gh_jid=456'), expected);
    assert.notEqual(canonicalizeUrl('https://boards.greenhouse.io/figma/jobs/456'), expected);
    assert.notEqual(canonicalizeUrl('https://boards.greenhouse.io/figma#jobs/123'), canonicalizeUrl('https://boards.greenhouse.io/figma#jobs/456'));
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com/jobs/123'])
        assert.throws(() => canonicalizeUrl(url));
});

test('experience and keyword preferences distinguish explicit levels and preserve unknown titles as unspecified', () => {
    const cases = [['Software Engineering Intern', 'internship'], ['Software Engineer I', 'new_grad'],
        ['Junior Software Engineer', 'new_grad'], ['Senior Software Engineer', 'experienced'],
        ['Software Engineer II', 'experienced'], ['Software Engineer', 'unspecified']];
    for (const [title, level] of cases) {
        const job = { title, location: 'San Jose, CA' };
        assert.equal(matchesSearch(job, { ...searchPreferences, experienceLevels: [level] }), true, title);
        assert.equal(matchesSearch(job, { ...searchPreferences, experienceLevels: [] }), false);
    }
    const job = { title: 'Frontend Software Engineer', location: 'San Jose, CA' };
    assert.equal(matchesSearch(job, { ...searchPreferences, keywords: ['FRONTEND', 'backend'] }), true);
    assert.equal(matchesSearch(job, { ...searchPreferences, excludedKeywords: ['frontend'] }), false);
    assert.equal(matchesSearch(job, { ...searchPreferences, keywords: ['backend'] }), false);
});

test('prepared matcher preserves stateful pattern safety across alternating locations and roles', async () => {
    const { createMatcher } = await import('../lib/matching.js');
    const match = createMatcher({ ...searchPreferences, rolePattern: /software engineer/gi,
        excludedRolePattern: /sales/giy, keywords: ['ENGINEER'] });
    for (let i = 0; i < 4; i++) {
        assert.equal(match({ title: 'Software Engineer', location: 'San José, California' }), true);
        assert.equal(match({ title: 'Software Engineer', location: 'Newark, NJ; Los Angeles, CA' }), false);
        assert.equal(match({ title: 'Software Engineer Sales', location: 'San Jose, CA' }), false);
    }
});
