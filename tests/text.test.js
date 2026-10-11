import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanText, plainText, textKey, normalizeListing, emailAddress } from '../lib/text.js';
import { canonicalizeUrl, experienceLevel, matchesSearch } from '../lib/matching.js';
import { skillMask } from '../lib/skills.js';
import { defaultPreferences, validatePreferences } from '../worker/preferences.js';
import { searchPreferences } from '../config/search.js';

test('natural language matching folds case, accents, width, spaces, quotes and invisible formatting', () => {
    for (const value of ['  ＰＹＴＨＯＮ\u00a0 Intern ', 'Py\u200bthon\tINTERN', 'Python\nIntern'])
        assert.equal(textKey(value), 'python intern');
    assert.equal(textKey('San Jose\u0301'), 'san jose');
    assert.equal(textKey('CO‑OP “Straße”'), 'co-op "strasse"');
    assert.equal(cleanText('  José\tMcDonald\n'), 'José McDonald');
    assert.equal(plainText('&lt;p&gt;C&plus;&plus;&nbsp;&amp; Python&lt;/p&gt;'), 'C++ & Python');
    assert.equal(textKey(textKey('Ｃ＋＋  Co‑op')), textKey('Ｃ＋＋  Co‑op'));
});
test('skills, role keywords, experience and locations agree across formatting variants', () => {
    assert.equal(skillMask('Ｃ＋＋ ＩＮＴＥＲＮ', '<p>PY\u200bTHON &amp; React</p>'), 38);
    const job = { title: 'ＳＯＦＴＷＡＲＥ\u00a0ＥＮＧＩＮＥＥＲ (ＣＯ‑ＯＰ)', location: 'ＳＡＮ ＪＯＳÉ， ＣＡ' };
    assert.equal(experienceLevel(job), 'internship');
    assert.equal(matchesSearch(job, { ...searchPreferences, keywords: [' software\tengineer '], experienceLevels: ['internship'] }), true);
    assert.equal(matchesSearch({ ...job, location: 'San José, Costa Rica' }, searchPreferences), false);
});
test('preferences canonicalize choices and deduplicate equivalent keywords without lowercasing display', () => {
    const result = validatePreferences({ ...defaultPreferences(), locations: [' ＳＡＮ\tＪＯＳÉ '], experienceLevels: [' INTERNSHIP '], keywords: [' Python ', 'PYTHON', 'Ｐｙｔｈｏｎ', 'C++'] });
    assert.deepEqual(result.locations, ['San Jose']);
    assert.deepEqual(result.experienceLevels, ['internship']);
    assert.deepEqual(result.keywords, ['Python', 'C++']);
    assert.throws(() => validatePreferences({ ...defaultPreferences(), keywords: ['\u200b'] }));
    assert.throws(() => normalizeListing({ title: '\u200b', company: 'X', location: '', url: 'https://example.com' }));
});
test('case-sensitive identity values stay intact and corrupt URL input is rejected', () => {
    assert.equal(canonicalizeUrl(' HTTPS://EXAMPLE.COM/Jobs/AbC?Token=XyZ '), 'https://example.com/Jobs/AbC?Token=XyZ');
    assert.notEqual(canonicalizeUrl('https://example.com/Jobs/AbC'), canonicalizeUrl('https://example.com/jobs/abc'));
    assert.throws(() => canonicalizeUrl('https://exa\nmple.com/Job'));
    assert.equal(emailAddress(' Mixed.Case@EXAMPLE.COM '), 'Mixed.Case@example.com');
});

test('inline HTML and spaced technical punctuation do not break skill or experience detection', () => {
    assert.equal(skillMask('Intern', '<p>Java<strong>Script</strong></p><p>Py<em>thon</em> C + +</p>'), 7);
    assert.equal(experienceLevel({ title: 'Software Engineer (Co – op)' }), 'internship');
    assert.equal(experienceLevel({ title: 'Software Engineer International' }), 'unspecified');
});
