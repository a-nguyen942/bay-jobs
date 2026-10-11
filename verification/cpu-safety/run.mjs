// Independent acceptance audit: public handlers, literal requirements, disposable D1.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { createWorker } from '../../worker/index.js';
import { createSources } from '../../worker/sources/index.js';

const results = [];
let harnessError = null;
const realNow = Date.now;
const realFetch = globalThis.fetch;
let networkAttempts = 0;
let inboxReads = 0;
const runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false });
const db = runtime.env.DB;
// Deliberately exclude all configured secrets and production bindings except this LOCAL DB.
const env = { DB: db, RESEND_API_KEY: 'audit-fake-key-never-sent', EMAIL_FROM: 'audit@example.invalid', ASSETS: { fetch: async () => new Response('fixture') } };
const today = () => new Date(Date.now()).toISOString().slice(0, 10);
const query = (sql, ...args) => db.prepare(sql).bind(...args);
const sources = [{ id: 'a', label: 'A', fetchListings: async () => [] }, { id: 'b', label: 'B', fetchListings: async () => [] }];
let app;
const call = (path, method = 'GET', body, headers = {}) => {
    if (path === '/api/jobs' && method === 'GET') inboxReads++;
    return app.fetch(new Request(`http://localhost${path}`, {
    method, headers: { Origin: 'http://localhost', ...headers }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
}), env);
};
const status = async () => { const response = await call('/api/jobs'); assert.equal(response.status, 200); return (await response.json()).monitor.safety; };
const seed = (amount, day = today(), starts = 0) => query('INSERT INTO work_budget_days VALUES (?, ?, ?)', day, amount, starts).run();
const scheduled = minute => app.scheduled({ scheduledTime: Date.parse(`${today()}T00:${String(minute).padStart(2, '0')}:00Z`) }, env);
const tables = [];
async function reset() {
    Date.now = realNow;
    for (const table of tables) await db.prepare(`DELETE FROM "${table}"`).run();
    await db.prepare('INSERT INTO notification_settings (id) VALUES (1)').run();
    await query('INSERT INTO work_budget_tracking VALUES (1, ?)', new Date().toISOString()).run();
    networkAttempts = 0; inboxReads = 0;
    app = createWorker(sources);
}
async function check(name, work) {
    await reset();
    const start = realNow();
    try { const evidence = await work(); results.push({ name, outcome: 'PASS', evidence, durationMs: realNow() - start }); }
    catch (error) { results.push({ name, outcome: 'FAIL', error: error.stack, durationMs: realNow() - start }); }
    console.log(`${results.at(-1).outcome}: ${name}`);
}
function streamed(size, headers = {}) {
    let remaining = size;
    return new Response(new ReadableStream({ pull(controller) {
        if (!remaining) { controller.close(); return; }
        const count = Math.min(remaining, 65536); remaining -= count;
        controller.enqueue(new Uint8Array(count).fill(32));
    } }), { headers });
}
try {
    for (const file of (await readdir('drizzle')).filter(f => f.endsWith('.sql')).sort()) {
        const sql = await readFile(`drizzle/${file}`, 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(s => s.trim()).map(s => db.prepare(s)));
    }
    tables.push(...(await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()).results.map(r => r.name).filter(name => !name.startsWith('_')));
    assert.ok(tables.every(t => /^[a-z_0-9]+$/i.test(t)));
    globalThis.fetch = async (input, options) => {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, options);
        networkAttempts++;
        throw new Error('Audit blocked external network');
    };
    await check('Admission accounting and explicit exclusions', async () => {
        assert.equal((await call('/api/check', 'POST', '{')).status, 400);
        assert.equal((await status()).reservedMs, 500);
        for (let i = 0; i < 5; i++) assert.equal((await call('/api/jobs')).status, 200);
        assert.equal((await call('/api/check', 'POST', '{}', { Origin: 'https://foreign.invalid' })).status, 403);
        assert.equal((await status()).reservedMs, 500);
        return { reservedMs: 500, unreservedInboxReads: inboxReads, unreservedForeignOriginRequests: 1, conclusion: 'Accounting does not cover all invocations.' };
    });
    await check('Twenty concurrent HTTP requests competing for one reservation', async () => {
        await seed(20_999_500);
        const responses = await Promise.all(Array.from({ length: 20 }, () => call('/api/check', 'POST', '{')));
        const codes = responses.map(r => r.status);
        assert.equal(codes.filter(n => n === 400).length, 1);
        assert.equal(codes.filter(n => n === 429).length, 19);
        assert.equal((await status()).reservedMs, 21_000_000);
        return { admittedToValidation: 1, denied: 19, reservedMs: 21_000_000 };
    });
    await check('Budget pause covers all mutation routes, scans, maintenance, and pending mail', async () => {
        await seed(21_000_000);
        await db.prepare("UPDATE notification_settings SET enabled = 1, recipient = 'audit@example.invalid' WHERE id = 1").run();
        await query("INSERT INTO notification_deliveries (id,payload,job_count,status,attempts,created_at,next_attempt_at) VALUES ('audit','{}',1,'pending',0,?,?)", new Date().toISOString(), new Date().toISOString()).run();
        const routes = [['/api/check','POST'],['/api/jobs/import','POST'],['/api/jobs/test','PATCH'],['/api/preferences','PATCH'],['/api/notifications','PATCH'],['/api/notifications/retry','POST'],['/api/notifications/test','POST'],['/api/filtered','POST'],['/api/coverage/accept-snapshot','POST'],['/api/watchdog','POST']];
        for (const [route, method] of routes) { const r = await call(route, method, {}); assert.equal(r.status, 429, route); assert.ok(Number(r.headers.get('Retry-After')) > 0); }
        let fetched = 0;
        app = createWorker(sources.map(s => ({ ...s, fetchListings: async () => { fetched++; return []; } })));
        await scheduled(0); await scheduled(38);
        assert.equal(fetched, 0); assert.equal(networkAttempts, 0);
        assert.deepEqual(await query("SELECT status, attempts FROM notification_deliveries WHERE id = 'audit'").first(), { status: 'pending', attempts: 0 });
        app = createWorker(sources);
        assert.equal((await status()).paused, true);
        assert.equal((await call('/api/check','POST',{action:'start'})).status,429);
        return { writeRoutesBlocked: routes.length, sourceFetches: fetched, externalRequests: networkAttempts, pendingEmailAttempts: 0, freshHandlerStillPaused: true };
    });
    await check('Positive control: an unpaused due email reaches the blocked transport', async () => {
        await db.prepare("UPDATE notification_settings SET enabled = 1, recipient = 'audit@example.invalid' WHERE id = 1").run();
        await query("INSERT INTO notification_deliveries (id,payload,job_count,status,attempts,created_at,next_attempt_at) VALUES ('audit','{}',1,'pending',0,?,?)", new Date().toISOString(), new Date().toISOString()).run();
        await scheduled(38);
        const row = await query("SELECT status, attempts FROM notification_deliveries WHERE id = 'audit'").first();
        assert.ok(networkAttempts > 0); assert.ok(row.attempts > 0);
        return { blockedExternalAttempts: networkAttempts, deliveryAttempts: row.attempts, realEmailsSent: 0 };
    });
    await check('Accounting table failure fails closed while other database tables remain accessible', async () => {
        await db.prepare('ALTER TABLE work_budget_days RENAME TO audit_hidden_budget').run();
        try {
            assert.equal((await call('/api/check','POST',{action:'start'})).status,503);
            await scheduled(0);
            assert.equal((await query('SELECT COUNT(*) AS n FROM source_runs').first()).n,0);
            assert.equal(networkAttempts,0);
        } finally { await db.prepare('ALTER TABLE audit_hidden_budget RENAME TO work_budget_days').run(); }
        return { mutationStatus: 503, persistedSourceAttempts: 0, externalRequests: 0 };
    });
    await check('Warning boundary and month rollover', async () => {
        Date.now = () => Date.parse('2026-09-30T23:59:59Z');
        await seed(14_999_500);
        assert.equal((await status()).warning,false);
        assert.equal((await call('/api/check','POST','{')).status,400);
        assert.equal((await status()).warning,true);
        Date.now = () => Date.parse('2026-10-01T00:00:00Z');
        assert.equal((await status()).reservedMs,15_000_000);
        return { belowWarning: 14_999_500, firstWarning: 15_000_000, retainedAcrossMonth: true };
    });
    await check('Resume time accounts for multiple expiring buckets', async () => {
        Date.now = () => Date.parse('2026-09-30T12:00:00Z');
        await seed(0,'2026-08-30'); await seed(21_000_000,'2026-08-31');
        assert.equal((await status()).resumeAt,'2026-10-02T00:00:00.000Z');
        Date.now = () => Date.parse('2026-10-01T23:59:59Z');
        assert.equal((await call('/api/check','POST','{')).status,429);
        Date.now = () => Date.parse('2026-10-02T00:00:00Z');
        assert.equal((await call('/api/check','POST','{')).status,400);
        assert.equal((await status()).reservedMs,500);
        return { resumeAt: '2026-10-02T00:00:00.000Z', beforeStatus: 429, atBoundaryStatus: 400, newReservedMs: 500 };
    });
    await check('Ten full manual scans, idempotent steps, eleventh denial, automatic continuation', async () => {
        let fetched = 0;
        app = createWorker(sources.map(s => ({ ...s, fetchListings: async () => { fetched++; return []; } })));
        for (let n=0; n<10; n++) {
            await db.prepare('DELETE FROM manual_check_budget').run(); // fixture cooldown only; separately tested below
            const start = await call('/api/check','POST',{action:'start'}); assert.equal(start.status,200);
            const {scan} = await start.json();
            for (let index=0; index<2; index++) {
                const body={action:'step',token:scan.token,index};
                assert.equal((await call('/api/check','POST',body)).status,200);
                assert.equal((await call('/api/check','POST',body)).status,200);
            }
        }
        assert.equal(fetched,20);
        await db.prepare('DELETE FROM manual_check_budget').run();
        assert.equal((await call('/api/check','POST',{action:'start'})).status,429);
        await db.prepare('DELETE FROM manual_check_budget').run();
        assert.equal((await call('/api/check','POST')).status,429);
        await scheduled(0); assert.equal(fetched,21);
        assert.equal((await status()).manualStarts,10);
        return { acceptedFullScans: 10, completedSourceChecks: 20, duplicateStepsRefetched: 0, automaticAdditionalFetches: 1, reservedMs: (await status()).reservedMs };
    });
    await check('Five-minute cooldown boundary and UTC daily reset via public requests', async () => {
        const start = Date.parse('2026-09-30T23:55:00Z'); Date.now = () => start;
        app = createWorker([]);
        assert.equal((await call('/api/check','POST',{action:'start'})).status,200);
        Date.now = () => start+299_999;
        assert.equal((await call('/api/check','POST',{action:'start'})).status,429);
        Date.now = () => start+300_000;
        assert.equal((await call('/api/check','POST',{action:'start'})).status,200);
        assert.equal((await status()).manualStarts,1);
        return { before300Seconds:429, at300Seconds:200, newUtcDayStarts:1 };
    });
    await check('Failures retain reservations, persist unfinished state, rotate, and bound recovery', async () => {
        const calls={a:0,b:0}; let unfinished=0;
        app=createWorker(sources.map(s=>({...s,fetchListings:async()=>{
            calls[s.id]++;
            const row=await query('SELECT last_attempt_at,error FROM source_runs WHERE source_id=?',s.id).first();
            assert.ok(row.last_attempt_at); assert.match(row.error,/has not completed/); unfinished++;
            throw new Error('Synthetic source failure');
        }})));
        await scheduled(0); await scheduled(1);
        for(let i=0;i<5;i++) await scheduled(2);
        assert.deepEqual(calls,{a:2,b:2});
        assert.equal((await status()).reservedMs,3500);
        return { sourceCalls:calls, unfinishedRecordsObserved:unfinished, scheduledInvocations:7, reservedMs:3500, realCpuTerminationTested:false };
    });
    await check('Request byte boundary, UTF-8 and dishonest Content-Length', async()=>{
        const cases=[[' '.repeat(65536),{},400],[' '.repeat(65537),{},413],['é'.repeat(32769),{},413],[' '.repeat(65537),{'Content-Length':'1'},413]];
        const codes=[];
        for(const [body,headers,expected] of cases){const r=await call('/api/check','POST',body,headers);assert.equal(r.status,expected);codes.push(r.status);}
        assert.equal((await status()).reservedMs,2000);
        return { statuses:codes, cases:['exact64KiB','oneByteOver','UTF8Bytes','falseSmallHeader'],reservedMs:2000 };
    });
    for(const kind of ['greenhouse','ashby','lever','github']) await check(`${kind}: oversized stream preserves prior success and saved jobs`,async()=>{
        const config={id:'size',kind,company:'Audit',boardToken:'audit',owner:'audit',repo:'audit',branch:'main',format:'vansh'};
        let fetched=0;
        app=createWorker(createSources([config],async()=>{fetched++;return streamed(20*1024*1024+1,{'Content-Length':'1'});}));
        const old='2026-01-01T00:00:00.000Z';
        await query('INSERT INTO source_runs(source_id,last_attempt_at,last_success_at) VALUES(?,?,?)','size',old,old).run();
        await query("INSERT INTO jobs(id,canonical_url,title,company,location,source_label,first_found_at,last_seen_at) VALUES ('saved','https://audit.invalid/job','Software Intern','Audit','San Jose, CA','Audit',?,?)",old,old).run();
        await db.prepare("INSERT INTO job_sources(job_id,source_id,missing_count) VALUES('saved','size',0)").run();
        await scheduled(0);
        const row=await query("SELECT last_success_at,error FROM source_runs WHERE source_id='size'").first();
        assert.equal(row.last_success_at,old);assert.match(row.error,/safety limit/);
        assert.equal((await query("SELECT closed_at FROM jobs WHERE id='saved'").first()).closed_at,null);
        assert.equal((await query("SELECT missing_count FROM job_sources WHERE job_id='saved'").first()).missing_count,0);
        return { fetched, streamedBytes:20*1024*1024+1, failedVisibly:true,lastSuccessPreserved:true,jobStillOpen:true };
    });
    await check('Listing count overflow fails before normalization or import',async()=>{
        app=createWorker([{id:'count',label:'Count',fetchListings:async()=>new Array(10001).fill({})}]);
        await scheduled(0);
        const row=await query("SELECT last_success_at,error FROM source_runs WHERE source_id='count'").first();
        assert.equal(row.last_success_at,null);assert.match(row.error,/10,000-listing safety limit/);
        assert.equal((await query('SELECT COUNT(*) AS n FROM jobs').first()).n,0);
        return {inputListings:10001,importedJobs:0,error:row.error};
    });
    await check('Concurrent Greenhouse details share one total feed limit',async()=>{
        const item=id=>({id,title:'Software Engineer Intern',absolute_url:`https://audit.invalid/${id}`,location:{name:'San Jose, CA'}});
        let details=0;
        app=createWorker(createSources([{id:'details',kind:'greenhouse',company:'Audit',boardToken:'audit',internshipsOnly:true}],async url=>{
            if(url.endsWith('/jobs'))return Response.json({jobs:[item(1),item(2)]});
            details++;
            return Response.json({...item(Number(url.split('/').at(-1))),content:'x'.repeat(11*1024*1024)});
        }));
        await scheduled(0);
        const row=await query("SELECT last_success_at,error FROM source_runs WHERE source_id='details'").first();
        assert.equal(details,2);assert.equal(row.last_success_at,null);assert.match(row.error,/safety limit/);
        assert.equal((await query('SELECT COUNT(*) AS n FROM jobs').first()).n,0);
        return { detailRequests:2, individualDescriptionMiB:11, importedJobs:0, error:row.error };
    });
} catch (error) { harnessError = error.stack; process.exitCode = 1; } finally {
    globalThis.fetch=realFetch;Date.now=realNow;
    await runtime.dispose();
    const output={observedAt:new Date().toISOString(),scope:'Independent public-handler acceptance tests with disposable local D1; no production writes',harnessError,passed:results.filter(r=>r.outcome==='PASS').length,failed:results.filter(r=>r.outcome==='FAIL').length,results};
    await writeFile('verification/cpu-safety/local-results.json',JSON.stringify(output,null,2)+'\n');
    console.log(JSON.stringify({passed:output.passed,failed:output.failed,harnessError}));
    if(output.failed)process.exitCode=1;
}
