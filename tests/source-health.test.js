import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceWarning } from '../lib/source-health.js';
test('source warnings distinguish failures, missing history, stale checks and fresh success', () => {
    const now = Date.parse('2026-09-16T12:00:00Z');
    assert.equal(sourceWarning({ lastSuccessAt: new Date(now - 60 * 60 * 1000).toISOString() }, now), '');
    assert.match(sourceWarning({ lastSuccessAt: new Date(now - 121 * 60 * 1000).toISOString() }, now), /over 2 hours/);
    assert.match(sourceWarning({ error: 'offline', consecutiveFailures: 3 }, now), /3 consecutive checks failed.*No successful check recorded/);
    assert.match(sourceWarning({ error: 'offline', consecutiveFailures: 1 }, now), /Latest check failed/);
});
