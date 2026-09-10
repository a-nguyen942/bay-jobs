import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { checkSources } from '../worker/monitor.js';
import { deliverNotifications, saveSettings, notificationState, retryNotifications, NotificationBusyError } from '../worker/notifications.js';
import { notificationApi } from '../worker/notification-api.js';
let runtime;
let db;
const now = Date.parse('2026-09-10T12:00:00Z');
const clock = () => now;
const env = () => ({ DB: db, RESEND_API_KEY: 'fake-key-never-sent', EMAIL_FROM: 'alerts@example.com' });
const settings = { enabled: true, recipient: 'me@example.com', cadence: 'each_check' };
const listing = (id) => ({ sourceJobId: id, title: `Software Engineer ${id}`, company: 'Example', location: 'San Jose, CA', url: `https://example.com/jobs/${id}`, postedAt: null });
const source = (ids, id = 'example') => ({ id, label: id, fetchListings: async () => ids.map(listing) });
before(async () => {
    runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false });
    db = runtime.env.DB;
    const directory = new URL('../drizzle/', import.meta.url);
    for (const file of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(new URL(file, directory), 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(sql => sql.trim()).map(sql => db.prepare(sql)));
    }
});
after(async () => { await runtime?.dispose(); });
beforeEach(async () => {
    await db.batch(['jobs', 'source_runs', 'notification_events', 'notification_deliveries', 'notification_lock'].map(table => db.prepare(`DELETE FROM ${table}`)));
    await db.prepare("UPDATE notification_settings SET enabled = 0, recipient = '', cadence = 'each_check', next_digest_at = NULL").run();
});
async function queued() {
    await saveSettings(env(), settings, now);
    await checkSources(db, [source(['baseline'])]);
    await checkSources(db, [source(['baseline', 'new'])]);
}
test('first imports stay quiet; only new jobs while enabled enter the queue, once across sources', async () => {
    await checkSources(db, [source(['off'])]);
    await saveSettings(env(), settings, now);
    await checkSources(db, [source(['off', 'new'])]);
    await checkSources(db, [source(['off', 'new']), source(['new', 'another-baseline'], 'second')]);
    const events = await db.prepare('SELECT title FROM notification_events').all();
    assert.deepEqual(events.results.map(row => row.title), ['Software Engineer new']);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM jobs').first())?.count, 3);
});
test('job and notification insertion roll back together on queue failure', async () => {
    await queued();
    await db.prepare("CREATE TRIGGER fail_notification BEFORE INSERT ON notification_events BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    try {
        const report = await checkSources(db, [source(['newer'])]);
        assert.ok(report[0].error);
        assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE title = 'Software Engineer newer'").first())?.count, 0);
    }
    finally {
        await db.prepare('DROP TRIGGER fail_notification').run();
    }
});
test('a failed baseline import can recover without notifying about the backlog', async () => {
    await saveSettings(env(), settings, now);
    await checkSources(db, [{ id: 'example', label: 'Example', fetchListings: async () => { throw new Error('offline'); } }]);
    await checkSources(db, [source(['baseline'])]);
    assert.equal((await notificationState(env())).queuedJobs, 0);
});
test('successful sends are recorded and never resent', async () => {
    await queued();
    const calls = [];
    const sender = async (payload, id) => { calls.push({ payload, id }); return 'receipt'; };
    await deliverNotifications(env(), sender, clock);
    await deliverNotifications(env(), sender, clock);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload.to, ['me@example.com']);
    assert.match(calls[0].payload.text, /Software Engineer new/);
    assert.doesNotMatch(calls[0].payload.text, /baseline/);
    assert.equal((await notificationState(env())).counts.sent, 1);
    assert.equal((await db.prepare('SELECT provider_id FROM notification_deliveries').first())?.provider_id, 'receipt');
});
test('network failures back off and reuse an identical payload and email ID', async () => {
    await queued();
    let first;
    await deliverNotifications(env(), async (payload, id) => { first = { payload, id }; throw new Error('secret transport details'); }, clock);
    const pending = await db.prepare('SELECT * FROM notification_deliveries').first();
    assert.equal(pending?.status, 'pending');
    assert.equal(pending?.attempts, 1);
    assert.doesNotMatch(String(pending?.error), /secret transport/);
    await deliverNotifications(env(), async () => { assert.fail('Must respect retry delay'); }, clock);
    await deliverNotifications({ ...env(), EMAIL_FROM: 'changed@example.com' }, async (payload, id) => {
        assert.deepEqual({ payload, id }, first);
        return 'receipt';
    }, () => now + 60_001);
    assert.equal((await notificationState(env())).counts.sent, 1);
});
test('interrupted sends recover within the window; expired ambiguous sends never auto-resend', async () => {
    await queued();
    await deliverNotifications(env(), async () => { throw new Error('timeout'); }, clock);
    await db.prepare("UPDATE notification_deliveries SET status = 'sending', lease_until = ?").bind(new Date(now - 1).toISOString()).run();
    let count = 0;
    await deliverNotifications(env(), async () => { count++; return 'receipt'; }, () => now + 60_001);
    assert.equal(count, 1);
    await db.prepare("UPDATE notification_deliveries SET status = 'pending'").run();
    await deliverNotifications(env(), async () => { assert.fail('Expired idempotency window must never resend'); }, () => now + 24 * 60 * 60 * 1000);
    assert.equal((await notificationState(env())).counts.uncertain, 1);
});
test('daily digest waits until due and combines new jobs in one email', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    await checkSources(db, [source(['baseline'])]);
    await checkSources(db, [source(['one', 'two'])]);
    await deliverNotifications(env(), async () => { assert.fail('Digest is not due'); }, clock);
    assert.equal((await notificationState(env())).queuedJobs, 2);
    let count = 0;
    await deliverNotifications(env(), async (payload) => { count++; assert.match(payload.subject, /2 new matches/); return 'receipt'; }, () => now + 24 * 60 * 60 * 1000);
    assert.equal(count, 1);
    assert.equal((await notificationState(env())).counts.sent, 1);
});
test('disabling or changing the recipient cancels unsent work without replay on re-enable', async () => {
    await queued();
    await deliverNotifications(env(), async () => { throw new Error('network'); }, clock);
    await checkSources(db, [source(['still-pending'])]);
    await saveSettings(env(), { ...settings, enabled: false }, now);
    await saveSettings(env(), settings, now);
    await deliverNotifications(env(), async () => { assert.fail('Cancelled work must not send'); }, () => now + 60_001);
    assert.equal((await notificationState(env())).queuedJobs, 0);
    assert.equal((await notificationState(env())).counts.cancelled, 1);
    await checkSources(db, [source(['new-address'])]);
    await saveSettings(env(), { ...settings, recipient: 'other@example.com' }, now);
    await deliverNotifications(env(), async () => { assert.fail('Old-address queue must not carry over'); }, clock);
});
test('delivery lock blocks overlapping sends and settings changes', async () => {
    await queued();
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const sending = deliverNotifications(env(), async () => { entered(); await waiting; return 'receipt'; }, clock);
    await started;
    try {
        await assert.rejects(deliverNotifications(env(), async () => 'no', clock), NotificationBusyError);
        await assert.rejects(saveSettings(env(), { ...settings, enabled: false }, now), NotificationBusyError);
    }
    finally {
        release();
        await sending;
    }
});
test('retries stop after five failures and manual retry retains the same ID', async () => {
    await queued();
    let time = now;
    for (let attempt = 1; attempt <= 5; attempt++) {
        await deliverNotifications(env(), async () => { throw new Error('network'); }, () => time);
        const row = await db.prepare('SELECT attempts, next_attempt_at FROM notification_deliveries').first();
        assert.equal(row?.attempts, attempt);
        time = Date.parse(row.next_attempt_at);
    }
    assert.equal((await notificationState(env())).counts.failed, 1);
    const original = await db.prepare('SELECT id FROM notification_deliveries').first();
    await retryNotifications(env(), time);
    await deliverNotifications(env(), async (_payload, id) => { assert.equal(id, original?.id); return 'receipt'; }, () => time);
    assert.equal((await notificationState(env())).counts.sent, 1);
});
test('settings API validates inputs, rejects foreign writes, and never exposes provider secrets', async () => {
    const call = (body, origin = 'http://localhost') => notificationApi(new Request('http://localhost/api/notifications', {
        method: 'PATCH', headers: { Origin: origin }, body: JSON.stringify(body),
    }), env());
    assert.equal((await call(settings, 'https://other.example')).status, 403);
    for (const value of [{}, { ...settings, recipient: 'bad' }, { ...settings, enabled: 'yes' }, { ...settings, cadence: 'weekly' }, { ...settings, key: 'secret' }])
        assert.equal((await call(value)).status, 400);
    assert.equal((await call(settings)).status, 200);
    const response = await notificationApi(new Request('http://localhost/api/notifications'), env());
    const text = await response.text();
    assert.doesNotMatch(text, /fake-key-never-sent|alerts@example.com/);
    const noKey = { DB: db };
    await assert.rejects(saveSettings(noKey, settings, now), /Configure/);
    await deliverNotifications(noKey, async () => { assert.fail('No key, no send'); });
});
