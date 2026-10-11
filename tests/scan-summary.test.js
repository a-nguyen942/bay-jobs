import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hourStart, scanSummary } from '../lib/scan-summary.js';
const now = Date.parse('2026-09-16T22:01:00Z');
const source = (id, fields = {}) => ({ sourceId: id, label: id, lastAttemptAt: null, lastSuccessAt: null, error: null, ...fields });
const success = id => source(id, { lastAttemptAt: '2026-09-16T22:00:10Z', lastSuccessAt: '2026-09-16T22:00:10Z' });
test('summary separates success, failure, and missing results without calling failed scans complete', () => {
    const sources = [success('success'), source('failed', { lastAttemptAt: '2026-09-16T22:00:20Z', error: 'offline' }), source('waiting')];
    let summary = scanSummary(sources, 4, now);
    assert.equal(summary.checked, 2);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.waiting, 1);
    assert.equal(summary.newMatches, 4);
    assert.equal(summary.status, 'waiting');
    assert.deepEqual(summary.failedSources, ['failed']);
    assert.deepEqual(summary.waitingSources, ['waiting']);
    assert.equal(scanSummary(sources, 4, now + 6 * 60000).status, 'incomplete');
    summary = scanSummary(sources.slice(0, 2), 4, now);
    assert.equal(summary.status, 'finished_with_errors');
    assert.equal(scanSummary([success('success'), success('recovered')], 4, now).status, 'complete');
});
test('previous-hour failures and successes reset, and future or unfinished timestamps do not count', () => {
    const sources = [source('old', { lastAttemptAt: '2026-09-16T21:59:00Z', lastSuccessAt: '2026-09-16T21:59:00Z' }),
        source('old-failure', { lastAttemptAt: '2026-09-16T21:59:00Z', error: 'offline' }),
        source('future', { lastAttemptAt: '2026-09-16T23:00:00Z', lastSuccessAt: '2026-09-16T23:00:00Z' }),
        source('unfinished', { lastAttemptAt: '2026-09-16T22:01:00Z' })];
    const summary = scanSummary(sources, 0, now);
    assert.equal(summary.checked, 0);
    assert.equal(summary.failed, 0);
    assert.equal(summary.waiting, 4);
    assert.equal(scanSummary([success('earlier')], 0, now + 60 * 60000).checked, 0);
    assert.equal(scanSummary([], 0, now).status, 'unconfigured');
});
test('hour boundaries remain separate across midnight and repeated Pacific daylight-saving hours', () => {
    assert.equal(hourStart(Date.parse('2026-09-17T07:59:59Z')), '2026-09-17T07:00:00.000Z');
    assert.equal(hourStart(Date.parse('2026-11-01T08:30:00Z')), '2026-11-01T08:00:00.000Z');
    assert.equal(hourStart(Date.parse('2026-11-01T09:30:00Z')), '2026-11-01T09:00:00.000Z');
});
