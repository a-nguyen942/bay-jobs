import { emailBudget, reserveEmailAttempt } from '../worker/email-budget.js';
import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { checkSources } from '../worker/monitor.js';
import { deliverNotifications, saveSettings, notificationState, retryNotifications, queueTestEmail, NotificationBusyError } from '../worker/notifications.js';
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
    await db.batch(['jobs', 'source_runs', 'notification_events', 'notification_deliveries', 'notification_lock', 'email_attempt_budget', 'scan_retries', 'source_integrity', 'source_checks', 'source_feed_cache', 'filtered_listings', 'search_settings'].map(table => db.prepare(`DELETE FROM ${table}`)));
    await db.prepare("UPDATE notification_settings SET enabled = 0, recipient = '', cadence = 'each_check', next_digest_at = NULL, skill_filter = 0, skill_mask = 63, skill_mode = 'any', internships_only = 0, scan_alerts = 1").run();
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

test('test emails use the durable queue and repeated clicks reuse the same message', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    const id = await queueTestEmail(env(), now);
    assert.equal(await queueTestEmail(env(), now + 1000), id);
    const calls = [];
    await deliverNotifications(env(), async (payload, messageId) => { calls.push({ payload, messageId }); return 'test-receipt'; }, clock);
    await deliverNotifications(env(), async () => { throw new Error('should not resend'); }, clock);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].messageId, id);
    assert.deepEqual(calls[0].payload.to, [settings.recipient]);
    assert.match(calls[0].payload.subject, /test notification/);
    assert.equal((await notificationState(env())).history[0].jobCount, 0);
});

test('test email requires setup and rejects cross-origin requests before queueing', async () => {
    await assert.rejects(queueTestEmail({ DB: db }, now), /Configure/);
    await assert.rejects(queueTestEmail(env(), now), /Enable/);
    const response = await notificationApi(new Request('http://localhost/api/notifications/test', { method: 'POST', headers: { Origin: 'https://foreign.example' } }), env());
    assert.equal(response.status, 403);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').first()).count, 0);
});

test('daily cap reserves atomically, keeps test emails queued, and resumes at expiry', async () => {
    await saveSettings(env(), settings, now);
    const results = await Promise.all(Array.from({ length: 101 }, () => reserveEmailAttempt(db, now)));
    assert.equal(results.filter(Boolean).length, 100);
    const id = await queueTestEmail(env(), now);
    let calls = 0;
    const sender = async () => { calls++; return 'receipt'; };
    await deliverNotifications(env(), sender, clock);
    assert.equal(calls, 0);
    assert.equal((await db.prepare('SELECT attempts FROM notification_deliveries WHERE id = ?').bind(id).first()).attempts, 0);
    assert.equal((await emailBudget(db, now)).dailyUsed, 100);
    await deliverNotifications(env(), sender, () => now + 86400000);
    assert.equal(calls, 1);
});
test('31-day cap blocks when daily budget is available and recovers at boundary', async () => {
    await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000)
        INSERT INTO email_attempt_budget(attempted_at) SELECT ? FROM n`).bind(now - 86400000).run();
    assert.equal((await emailBudget(db, now)).dailyUsed, 0);
    assert.equal(await reserveEmailAttempt(db, now), false);
    assert.equal(await reserveEmailAttempt(db, now + 30 * 86400000), true);
});
test('failed attempts and retries consume budget; settings changes do not reset it', async () => {
    await queued();
    const fail = async () => { throw new Error('offline'); };
    await deliverNotifications(env(), fail, clock);
    await deliverNotifications(env(), fail, () => now + 60000);
    assert.equal((await emailBudget(db, now + 60000)).dailyUsed, 2);
    await saveSettings(env(), { ...settings, enabled: false }, now + 60000);
    await saveSettings(env(), settings, now + 60000);
    assert.equal((await emailBudget(db, now + 60000)).dailyUsed, 2);
});

test('idle email passes and future digests perform no database writes', async () => {
    for (const cadence of ['each_check', 'daily']) {
        await saveSettings(env(), { ...settings, cadence }, now);
        if (cadence === 'daily') await checkSources(db, [source(['baseline'])]);
        if (cadence === 'daily') await checkSources(db, [source(['baseline', 'waiting-for-digest'])]);
        await db.prepare("CREATE TRIGGER reject_idle_lock BEFORE INSERT ON notification_lock BEGIN SELECT RAISE(ABORT, 'idle pass attempted a write'); END").run();
        try {
            await deliverNotifications(env(), async () => { assert.fail('No email should be due'); }, clock);
        } finally { await db.prepare('DROP TRIGGER reject_idle_lock').run(); }
    }
    assert.equal((await notificationState(env())).queuedJobs, 1);
});

test('idle fast path still performs expired-attempt maintenance', async () => {
    await saveSettings(env(), settings, now);
    await db.prepare('INSERT INTO email_attempt_budget (attempted_at) VALUES (?)').bind(now - 31 * 86_400_000 - 1).run();
    await deliverNotifications(env(), async () => { assert.fail('Maintenance should not send email'); }, clock);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM email_attempt_budget').first()).n, 0);
});

test('optional email skills filter future discoveries by any/all and internships without hiding inbox jobs', async () => {
    await saveSettings(env(), { ...settings, skillFilter: true, skillMask: 3, skillMode: 'all', internshipsOnly: true }, now);
    await checkSources(db, [source(['baseline'])]);
    const feed = [
        { ...listing('both'), title: 'Software Engineer Intern', description: 'JS and Python' },
        { ...listing('one'), title: 'Software Engineer Intern', description: 'Python' },
        { ...listing('not-intern'), title: 'Software Engineer', description: 'JS and Python' },
    ];
    await checkSources(db, [{ id: 'example', label: 'Example', fetchListings: async () => feed }]);
    assert.equal((await notificationState(env())).queuedJobs, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n, 4);
    assert.equal((await db.prepare('SELECT url FROM notification_events').first()).url, listing('both').url);
    await saveSettings(env(), { ...settings, skillFilter: true, skillMask: 3, skillMode: 'any', internshipsOnly: false }, now);
    await checkSources(db, [{ id: 'example', label: 'Example', fetchListings: async () => [{ ...listing('any'), description: 'Python' }] }]);
    assert.equal((await notificationState(env())).queuedJobs, 2);
    await saveSettings(env(), { ...settings, skillFilter: false }, now);
    await checkSources(db, [source(['no-skills'])]);
    assert.equal((await notificationState(env())).queuedJobs, 3);
    const state = await notificationState(env());
    assert.equal(state.settings.skillFilter, false);
    assert.equal(state.settings.skillMask, 3);
});

test('email filter API persists choices and rejects malformed values', async () => {
    const call = body => notificationApi(new Request('http://localhost/api/notifications', {
        method: 'PATCH', headers: { Origin: 'http://localhost' }, body: JSON.stringify(body),
    }), env());
    const body = { ...settings, skillFilter: true, skillMask: 6, skillMode: 'all', internshipsOnly: true };
    assert.equal((await call(body)).status, 200);
    const state = await notificationState(env());
    assert.equal(state.settings.skillMask, 6);
    assert.equal(state.settings.internshipsOnly, true);
    for (const change of [{ skillFilter: 'yes' }, { skillMask: 64 }, { skillMask: 0 }, { skillMask: 1.5 }, { skillMode: 'none' }, { internshipsOnly: 'yes' }]) {
        assert.equal((await call({ ...body, ...change })).status, 400);
    }
});

test('daily summary sends upcoming and overdue reminders without new jobs, only once per day', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily', skillFilter: true, skillMask: 4 }, now);
    await checkSources(db, [source(['follow', 'deadline', 'future', 'rejected', 'applied', 'archived'])]);
    await db.prepare("UPDATE jobs SET follow_up_date = '2026-09-10' WHERE canonical_url = ?").bind(listing('follow').url).run();
    await db.prepare("UPDATE jobs SET deadline_date = '2026-09-16' WHERE canonical_url = ?").bind(listing('deadline').url).run();
    await db.prepare("UPDATE jobs SET deadline_date = '2026-10-01' WHERE canonical_url = ?").bind(listing('future').url).run();
    for (const status of ['rejected', 'applied', 'archived']) await db.prepare("UPDATE jobs SET deadline_date = '2026-09-12', application_status = ? WHERE canonical_url = ?").bind(status, listing(status).url).run();
    const calls = [];
    const send = async (payload, id) => { calls.push({ payload, id }); return 'receipt'; };
    const due = now + 24 * 60 * 60 * 1000;
    await deliverNotifications(env(), send, () => due);
    await deliverNotifications(env(), send, () => due + 60000);
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /follow[\s\S]*overdue/);
    assert.match(calls[0].payload.text, /deadline[\s\S]*2026-09-16/);
    assert.doesNotMatch(calls[0].payload.text, /Software Engineer (future|rejected|applied|archived)/);
    assert.equal((await notificationState(env())).history[0].kind, 'digest');
    // A reminder-only summary must not be mistaken for the test-email deduplication record.
    const testId = await queueTestEmail(env(), due + 1);
    assert.notEqual(testId, calls[0].id);
});

test('daily summary bounds new matches and advances once, leaving overflow for tomorrow', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    await checkSources(db, [source(['baseline'])]);
    await checkSources(db, [source(Array.from({ length: 55 }, (_, i) => `new-${i}`))]);
    const calls = [];
    const send = async payload => { calls.push(payload); return 'receipt'; };
    const due = now + 24 * 60 * 60 * 1000;
    await deliverNotifications(env(), send, () => due);
    assert.equal(calls.length, 1);
    assert.equal((await notificationState(env())).queuedJobs, 5);
    await deliverNotifications(env(), send, () => due + 60000);
    assert.equal(calls.length, 1);
    await deliverNotifications(env(), send, () => due + 24 * 60 * 60 * 1000);
    assert.equal(calls.length, 2);
    assert.match(calls[1].subject, /5 new matches/);
    assert.equal((await notificationState(env())).queuedJobs, 0);
});

test('daily reminder payload and due time commit atomically and retries retain one message', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    await checkSources(db, [source(['reminder'])]);
    await db.prepare("UPDATE jobs SET follow_up_date = '2026-09-10'").run();
    const due = now + 24 * 60 * 60 * 1000;
    await db.prepare("CREATE TRIGGER fail_digest BEFORE UPDATE OF next_digest_at ON notification_settings BEGIN SELECT RAISE(ABORT, 'test failure'); END").run();
    try {
        await assert.rejects(deliverNotifications(env(), async () => assert.fail('must not send'), () => due));
        assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 0);
    } finally { await db.prepare('DROP TRIGGER fail_digest').run(); }
    let first;
    await deliverNotifications(env(), async (payload, id) => { first = { payload, id }; throw new Error('offline'); }, () => due);
    await deliverNotifications(env(), async (payload, id) => { assert.deepEqual({ payload, id }, first); return 'receipt'; }, () => due + 60001);
    assert.equal((await notificationState(env())).counts.sent, 1);
});

test('incomplete-scan alerts wait for recovery, deduplicate by hour, and share the delivery queue', async () => {
    const { queueScanAlert } = await import('../worker/notifications.js');
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    const feeds = [{ id: 'healthy', label: 'Healthy' }, { id: 'failed', label: 'Failed' }, { id: 'missing', label: 'Missing' }];
    const start = Math.floor(now / 3600000) * 3600000;
    const iso = time => new Date(time).toISOString();
    await db.prepare('INSERT INTO source_runs (source_id, last_attempt_at, last_success_at, error) VALUES (?, ?, ?, NULL)').bind('healthy', iso(start), iso(start)).run();
    await db.prepare('INSERT INTO source_runs (source_id, last_attempt_at, error) VALUES (?, ?, ?)').bind('failed', iso(start), 'offline').run();
    await queueScanAlert(env(), feeds, start + 5 * 60000);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 0);
    await queueScanAlert(env(), feeds, start + 6 * 60000);
    await queueScanAlert(env(), feeds, start + 7 * 60000);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 1);
    const warning = await db.prepare('SELECT * FROM notification_deliveries').first();
    assert.equal(warning.kind, 'scan_alert');
    assert.match(JSON.parse(warning.payload).text, /Failed: Failed/);
    assert.match(JSON.parse(warning.payload).text, /Missing results: Missing/);
    const calls = [];
    await deliverNotifications(env(), async payload => { calls.push(payload); return 'receipt'; }, () => start + 7 * 60000);
    assert.equal(calls.length, 1);
    assert.match(calls[0].subject, /incomplete source scan/);
    await queueScanAlert(env(), feeds, start + 3600000 + 6 * 60000);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 2);
});

test('healthy scans and disabled warnings do not queue alerts; turning warnings off cancels pending warnings only', async () => {
    const { queueScanAlert } = await import('../worker/notifications.js');
    const feeds = [{ id: 'healthy', label: 'Healthy' }];
    const start = Math.floor(now / 3600000) * 3600000;
    const at = start + 34 * 60000;
    await saveSettings(env(), settings, now);
    await db.prepare('INSERT INTO source_runs (source_id, last_attempt_at, last_success_at) VALUES (?, ?, ?)')
        .bind('healthy', new Date(start).toISOString(), new Date(start).toISOString()).run();
    await queueScanAlert(env(), feeds, at);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 0);
    await db.prepare('DELETE FROM source_runs').run();
    await saveSettings(env(), { ...settings, scanAlerts: false }, now);
    await queueScanAlert(env(), feeds, at);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM notification_deliveries').first()).n, 0);
    await saveSettings(env(), { ...settings, scanAlerts: true }, now);
    await queueScanAlert(env(), feeds, at);
    await queueTestEmail(env(), at);
    await saveSettings(env(), { ...settings, scanAlerts: false }, at);
    assert.equal((await db.prepare("SELECT status FROM notification_deliveries WHERE kind = 'scan_alert'").first()).status, 'cancelled');
    assert.equal((await db.prepare("SELECT status FROM notification_deliveries WHERE kind = 'test'").first()).status, 'pending');
});

test('daily coverage is sent even without new jobs or reminders and shares the daily schedule', async () => {
    await saveSettings(env(), { ...settings, cadence: 'daily' }, now);
    const calls = [];
    const due = now + 24 * 60 * 60 * 1000;
    await deliverNotifications(env(), async payload => { calls.push(payload); return 'coverage-receipt'; }, () => due);
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /Coverage for .*Pacific/);
    assert.match(calls[0].text, /Overdue now:/);
    await deliverNotifications(env(), async payload => { calls.push(payload); return 'unexpected'; }, () => due + 60000);
    assert.equal(calls.length, 1);
});

test('formatted internship titles use the same classification for email and inbox', async () => {
    await saveSettings(env(), { ...settings, skillFilter: true, skillMask: 2, skillMode: 'any', internshipsOnly: true }, now);
    assert.equal((await checkSources(db, [source(['baseline'])]))[0].error, null);
    const checked = await checkSources(db, [{ id: 'example', label: 'Example', fetchListings: async () => [
        { ...listing('formatted'), title: 'ＳＯＦＴＷＡＲＥ Engineer (ＣＯ‑ＯＰ)', description: 'PY\u200bTHON' },
        { ...listing('international'), title: 'Software Engineer International', description: 'Python' },
    ] }]);
    assert.equal(checked[0].error, null);
    assert.equal((await notificationState(env())).queuedJobs, 1);
    assert.equal((await db.prepare('SELECT url FROM notification_events').first()).url, listing('formatted').url);
});

test('email settings accept formatting on enum values while preserving mailbox identity', async () => {
    const response = await notificationApi(new Request('http://localhost/api/notifications', {
        method: 'PATCH', headers: { Origin: 'http://localhost', 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false, recipient: ' Mixed.Case@EXAMPLE.COM ', cadence: ' DAILY ', skillMode: ' ALL ' }),
    }), env());
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.settings.recipient, 'Mixed.Case@example.com');
    assert.equal(result.settings.cadence, 'daily');
    assert.equal(result.settings.skillMode, 'all');
});
