import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInbox } from '../web/inbox.js';
const job = {
    id: 'one', canonicalUrl: 'https://example.com/jobs/1', title: 'Software Engineer',
    company: 'Example', location: 'San Jose, CA', sourceLabel: 'Example board',
    firstFoundAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z',
    postedAt: null, seenAt: null, applicationStatus: 'considering', isDemo: false,
};
const payload = (jobs = [job]) => ({
    jobs, pagination: { page: 1, pageSize: 50, total: jobs.length, pages: 1 }, summary: { total: jobs.length, unseen: jobs.filter(job => !job.seenAt).length, demo: 0 }, monitor: { sourceCount: 0, lastCheckedAt: null, notificationMode: 'disabled', errors: [] },
});
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
test('an old refresh cannot overwrite an application status saved while it was in flight', async () => {
    const stale = deferred();
    const replies = [Promise.resolve(Response.json(payload())), stale.promise, Promise.resolve(Response.json({ ...job, applicationStatus: 'applied' })), Promise.resolve(Response.json(payload([{ ...job, applicationStatus: 'applied' }])))];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.refresh();
    const refreshing = inbox.refresh();
    await inbox.update(job.id, { applicationStatus: 'applied' });
    stale.resolve(Response.json(payload()));
    await refreshing;
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'applied');
});
test('opening a second job can save seen state while the first job is still saving', async () => {
    const first = deferred();
    const second = deferred();
    const other = { ...job, id: 'two' };
    const replies = [Promise.resolve(Response.json(payload([job, other]))), first.promise, second.promise, Promise.resolve(Response.json(payload([{ ...job, seenAt: '2026-01-02T00:00:00Z' }, { ...job, id: 'two', seenAt: '2026-01-02T00:00:00Z' }])))];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.refresh();
    const savingFirst = inbox.update(job.id, { seen: true });
    const savingSecond = inbox.update(other.id, { seen: true });
    assert.equal(inbox.isSaving(job.id), true);
    assert.equal(inbox.isSaving(other.id), true);
    second.resolve(Response.json({ ...other, seenAt: '2026-01-02T00:00:00Z' }));
    first.resolve(Response.json({ ...job, seenAt: '2026-01-02T00:00:00Z' }));
    await Promise.all([savingFirst, savingSecond]);
    assert.ok(inbox.data?.jobs.every(item => item.seenAt));
    assert.equal(inbox.isSaving(job.id), false);
    assert.equal(inbox.isSaving(other.id), false);
});
test('failed writes keep saved state and remain visible after a successful background refresh', async () => {
    const replies = [Response.json(payload()), new Response(null, { status: 503 }), Response.json(payload()), Response.json({ ...job, applicationStatus: 'applied' }), Response.json(payload([{ ...job, applicationStatus: 'applied' }]))];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.refresh();
    await inbox.update(job.id, { applicationStatus: 'applied' });
    await inbox.refresh();
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'considering');
    assert.match(inbox.error, /not saved/);
    assert.equal(inbox.isSaving(job.id), false);
    await inbox.update(job.id, { applicationStatus: 'applied' });
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'applied');
    assert.equal(inbox.error, '');
});
test('overlapping refreshes accept only the most recently requested snapshot', async () => {
    const first = deferred();
    const second = deferred();
    const replies = [first.promise, second.promise];
    const inbox = createInbox(() => { }, async () => replies.shift());
    const older = inbox.refresh();
    const newer = inbox.refresh();
    second.resolve(Response.json(payload([{ ...job, applicationStatus: 'applied' }])));
    await newer;
    first.resolve(Response.json(payload()));
    await older;
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'applied');
});
test('manual checking prevents duplicate clicks and refreshes the inbox after import', async () => {
    const check = deferred();
    const calls = [];
    const inbox = createInbox(() => { }, async (path, options) => {
        calls.push(String(path));
        if (path === '/api/check') {
            assert.equal(options?.method, 'POST');
            return check.promise;
        }
        return Response.json(payload());
    });
    const checking = inbox.check();
    assert.equal(inbox.checking, true);
    await inbox.check();
    assert.deepEqual(calls, ['/api/check']);
    check.resolve(Response.json({ report: [{ sourceId: 'figma', inserted: 1, matched: 3, error: null }] }));
    await checking;
    assert.equal(inbox.checking, false);
    assert.deepEqual(calls, ['/api/check', '/api/jobs?view=all&q=&page=1']);
    assert.match(inbox.checkMessage, /1 new job added/);
    assert.equal(inbox.data?.jobs.length, 1);
});
test('source failures are visible even when other sources import jobs successfully', async () => {
    const replies = [Response.json({ report: [
                { sourceId: 'healthy', inserted: 1, matched: 1, error: null },
                { sourceId: 'failed', inserted: 0, matched: 0, error: 'HTTP 503' },
            ] }), Response.json(payload())];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.check();
    assert.match(inbox.error, /1 source check\(s\) failed/);
    assert.match(inbox.checkMessage, /1 new job added/);
    assert.equal(inbox.checking, false);
});
test('a check conflict is actionable and the button can be retried after failure', async () => {
    const replies = [new Response(null, { status: 409 }), Response.json({ report: [] }), Response.json(payload())];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.check();
    assert.match(inbox.error, /already running/);
    assert.equal(inbox.checking, false);
    await inbox.check();
    assert.equal(inbox.error, '');
    assert.equal(inbox.checkMessage, 'No job sources configured.');
});
test('finishing an import during a status write refreshes after the write settles', async () => {
    const saving = deferred();
    const other = { ...job, id: 'new-job' };
    const replies = [Promise.resolve(Response.json(payload())), saving.promise,
        Promise.resolve(Response.json({ report: [{ sourceId: 'figma', inserted: 1, matched: 2, error: null }] })),
        Promise.resolve(Response.json(payload([{ ...job, applicationStatus: 'applied' }, other]))),
    ];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.refresh();
    const write = inbox.update(job.id, { applicationStatus: 'applied' });
    await inbox.check();
    assert.equal(inbox.data?.jobs.length, 1);
    saving.resolve(Response.json({ ...job, applicationStatus: 'applied' }));
    await write;
    assert.equal(inbox.data?.jobs.length, 2);
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'applied');
});
test('changing filters resets the page and ignores an older response', async () => {
    const old = deferred();
    const paths = [];
    const inbox = createInbox(() => { }, async (path) => {
        paths.push(String(path));
        if (paths.length === 1)
            return old.promise;
        return Response.json(payload([{ ...job, applicationStatus: 'applied' }]));
    });
    const previous = inbox.navigate({ page: 3 });
    await inbox.navigate({ view: 'applied', query: 'Example' });
    old.resolve(Response.json(payload()));
    await previous;
    assert.deepEqual(paths, ['/api/jobs?view=all&q=&page=3', '/api/jobs?view=applied&q=Example&page=1']);
    assert.equal(inbox.filters.page, 1);
    assert.equal(inbox.data?.jobs[0].applicationStatus, 'applied');
    assert.equal(inbox.loading, false);
});
test('a disappearing last page is corrected and selected job details survive a filtered-out write', async () => {
    const last = { ...payload(), pagination: { page: 2, pageSize: 50, total: 51, pages: 2 } };
    const empty = { ...payload([]), pagination: { page: 2, pageSize: 50, total: 50, pages: 1 } };
    const replies = [Response.json(last), Response.json({ ...job, applicationStatus: 'archived' }), Response.json(empty), Response.json(payload([])), Response.json(payload([{ ...job, applicationStatus: 'archived' }]))];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.navigate({ page: 2 });
    inbox.select(job);
    await inbox.update(job.id, { applicationStatus: 'archived' });
    assert.equal(inbox.filters.page, 1);
    assert.equal(inbox.selected?.applicationStatus, 'archived');
    assert.equal(inbox.data?.jobs.length, 0);
    await inbox.navigate({ view: 'archived' });
    assert.equal(inbox.selected, null);
});
test('a failed write during refresh does not leave page controls stuck loading', async () => {
    const old = deferred();
    const replies = [Promise.resolve(Response.json(payload())), old.promise,
        Promise.resolve(new Response(null, { status: 503 })), Promise.resolve(Response.json(payload()))];
    const inbox = createInbox(() => { }, async () => replies.shift());
    await inbox.refresh();
    const refreshing = inbox.refresh();
    await inbox.update(job.id, { seen: true });
    old.resolve(Response.json(payload()));
    await refreshing;
    assert.equal(inbox.loading, false);
    assert.match(inbox.error, /not saved/);
});
