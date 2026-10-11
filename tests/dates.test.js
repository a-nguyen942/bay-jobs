import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validDate, localDate } from '../lib/dates.js';

test('follow-up dates reject impossible days and timestamps while accepting leap days', () => {
    for (const value of ['2026-02-29', '2026-04-31', '0000-01-01', '2026-9-1', '2026-09-01T12:00:00Z', null, 42]) assert.equal(validDate(value), false);
    for (const value of ['2024-02-29', '2026-09-01', '9999-12-31']) assert.equal(validDate(value), true);
    assert.equal(localDate(new Date(2026, 8, 13, 23)), '2026-09-13');
});
