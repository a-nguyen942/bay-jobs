import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { cpuBudget, reserveWork, cleanCpuBudget, CPU_STOP_MS, CPU_WARNING_MS, CPU_PER_INVOCATION_MS, CpuBudgetError } from '../worker/cpu-budget.js';
import { readBoundedText, createFeedReader, FEED_BYTE_LIMIT } from '../worker/bounded-body.js';
import { createWorker } from '../worker/index.js';
import { checkSources } from '../worker/monitor.js';
import { runCheck, startManualScan, stepManualScan } from '../worker/check.js';

let runtime, db;
const NOW = Date.parse('2026-09-22T18:30:00Z');
before(async () => {
    runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false });
    db = runtime.env.DB;
    for (const name of (await readdir('drizzle')).filter(name => name.endsWith('.sql')).sort()) {
        const sql = await readFile(`drizzle/${name}`, 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(s => s.trim()).map(s => db.prepare(s)));
    }
});
after(async () => { await runtime?.dispose(); });
beforeEach(async () => {
    for (const table of ['work_budget_days', 'source_runs', 'monitor_lock', 'manual_scans', 'manual_check_budget', 'source_checks'])
        await db.prepare(`DELETE FROM ${table}`).run();
});
async function seed(ms, now = NOW, starts = 0) {
    await db.prepare('INSERT INTO work_budget_days VALUES (?, ?, ?)').bind(new Date(now).toISOString().slice(0, 10), ms, starts).run();
}
test('deployed CPU ceiling and reservations cannot drift apart', async () => {
    const config = JSON.parse(await readFile('wrangler.json', 'utf8'));
    assert.equal(config.limits.cpu_ms, CPU_PER_INVOCATION_MS);
    assert.equal(config.preview_urls, false);
});
test('atomic budget permits only the last available reservation across concurrent requests', async () => {
    await seed(CPU_STOP_MS - CPU_PER_INVOCATION_MS);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => reserveWork(db, NOW)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason instanceof CpuBudgetError));
    const status = await cpuBudget(db, NOW);
    assert.equal(status.reservedMs, CPU_STOP_MS);
    assert.equal(status.paused, true);
    assert.equal(status.resumeAt, '2026-10-24T00:00:00.000Z');
});
test('warning threshold and conservative rolling window do not reset at a month boundary', async () => {
    await seed(CPU_WARNING_MS);
    assert.equal((await cpuBudget(db, NOW)).warning, true);
    assert.equal((await cpuBudget(db, Date.parse('2026-10-01T00:00:00Z'))).reservedMs, CPU_WARNING_MS);
    assert.equal((await cpuBudget(db, Date.parse('2026-10-23T23:59:59Z'))).reservedMs, CPU_WARNING_MS);
    assert.equal((await cpuBudget(db, Date.parse('2026-10-24T00:00:00Z'))).reservedMs, 0);
    await cleanCpuBudget(db, Date.parse('2026-10-24T00:00:00Z'));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM work_budget_days').first()).n, 0);
});
test('daily manual limit is atomic, resets at UTC midnight and does not block scheduled reservations', async () => {
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => reserveWork(db, NOW, { manualStart: true })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 10);
    await reserveWork(db, NOW);
    assert.equal((await cpuBudget(db, NOW)).manualStarts, 10);
    await reserveWork(db, Date.parse('2026-09-23T00:00:00Z'), { manualStart: true });
    assert.equal((await cpuBudget(db, Date.parse('2026-09-23T00:00:00Z'))).manualStarts, 1);
});
test('both legacy checks and full scan starts share daily manual allowance; steps do not consume starts', async () => {
    await seed(0, NOW, 9);
    const sources = [{ id: 'empty', label: 'Empty', fetchListings: async () => [] }];
    const scan = await startManualScan(db, sources, () => NOW);
    const done = await stepManualScan(db, sources, scan.token, 0, () => NOW + 1000);
    assert.equal(done.done, true);
    assert.equal((await cpuBudget(db, NOW)).manualStarts, 10);
    await assert.rejects(runCheck(db, sources, { manual: true, rotate: true, clock: () => NOW + 360_000 }), /10 manual scan starts/);
    await runCheck(db, sources, { rotate: true, clock: () => NOW + 360_000 });
});
test('budget pause blocks scans, mail processing and changes, while allowing inbox reads', async () => {
    await seed(CPU_STOP_MS, Date.now());
    let calls = 0;
    const app = createWorker([{ id: 'one', label: 'One', fetchListings: async () => { calls++; return []; } }]);
    await app.scheduled({ scheduledTime: Date.now() }, runtime.env);
    assert.equal(calls, 0);
    const write = await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' }, body: '{"action":"start"}' }), runtime.env);
    assert.equal(write.status, 429);
    assert.ok(Number(write.headers.get('Retry-After')) > 0);
    const read = await app.fetch(new Request('http://localhost/api/jobs'), runtime.env);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).monitor.safety.paused, true);
    assert.equal(calls, 0);
});
test('missing budget database fails closed before any scheduled or manual work', async () => {
    const broken = { DB: { prepare() { throw new Error('offline'); } } };
    let calls = 0;
    const app = createWorker([{ id: 'one', label: 'One', fetchListings: async () => { calls++; return []; } }]);
    await app.scheduled({}, broken);
    const response = await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' } }), broken);
    assert.equal(response.status, 503);
    assert.equal(calls, 0);
});
test('oversized mutation bodies are rejected, and the attempt is still reserved', async () => {
    const app = createWorker([]);
    const response = await app.fetch(new Request('http://localhost/api/check', { method: 'POST', headers: { Origin: 'http://localhost' }, body: 'x'.repeat(65 * 1024) }), runtime.env);
    assert.equal(response.status, 413);
    assert.equal((await cpuBudget(db)).reservedMs, CPU_PER_INVOCATION_MS);
});
test('body limits count actual bytes without Content-Length and cancel oversized streams', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(20)); },
        cancel() { cancelled = true; },
    }));
    await assert.rejects(readBoundedText(response, 10), /safety limit/);
    assert.equal(cancelled, true);
    assert.equal(await readBoundedText(new Response('é'), 2), 'é');
    await assert.rejects(readBoundedText(new Response('é'), 1), /safety limit/);
});
test('multi-page JSON feeds share one byte allowance rather than one per page', async () => {
    const read = createFeedReader();
    const largeJson = JSON.stringify('x'.repeat(FEED_BYTE_LIMIT / 2));
    assert.equal((await read(new Response(largeJson))).length, FEED_BYTE_LIMIT / 2);
    await assert.rejects(read(new Response(largeJson)), /safety limit/);
});
test('unfinished attempt is durable before the adapter runs and oversized feeds never become success', async () => {
    let observed;
    const source = { id: 'huge', label: 'Huge', fetchListings: async () => {
        observed = await db.prepare('SELECT * FROM source_runs WHERE source_id = ?').bind('huge').first();
        return new Array(10_001).fill({});
    } };
    const report = await checkSources(db, [source]);
    assert.ok(observed.last_attempt_at);
    assert.match(observed.error, /has not completed/);
    assert.match(report[0].error, /10,000-listing safety limit/);
    assert.equal((await db.prepare('SELECT last_success_at FROM source_runs WHERE source_id = ?').bind('huge').first()).last_success_at, null);
});
