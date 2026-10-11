// Isolated local replay: no saved inbox writes, credentials, or real email sends.
import { getPlatformProxy } from 'wrangler';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { sources } from '../config/sources.js';
import { createSources } from '../worker/sources/index.js';
import { runCheck } from '../worker/check.js';
import { deliverNotifications, queueTestEmail, saveSettings } from '../worker/notifications.js';

const args = process.argv.slice(2);
const argument = name => args.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
// Optional public response snapshot permits repeatable comparisons without re-fetching.
const snapshot = argument('snapshot');
const cache = snapshot ? JSON.parse(await readFile(snapshot, 'utf8')) : {};
const outputPath = argument('output') ?? 'usage-report.json';
const fetched = [];
for (const config of sources) {
    let bytes = 0;
    let requests = 0;
    const request = async (url, options) => {
        if (!cache[url]) {
            if (snapshot) throw new Error('Source missing from snapshot');
            const response = await fetch(url, options);
            cache[url] = { status: response.status, headers: Object.fromEntries(response.headers),
                body: Buffer.from(await response.arrayBuffer()).toString('base64') };
        }
        const saved = cache[url];
        const body = Buffer.from(saved.body, 'base64');
        bytes += body.length; requests++;
        return new Response(body, { status: saved.status, headers: saved.headers });
    };
    try {
        const listings = await createSources([config], request)[0].fetchListings();
        fetched.push({ sourceId: config.id, listings: listings.length, bytes, requests });
    } catch { fetched.push({ sourceId: config.id, error: 'Source fetch failed; excluded from measurement.' }); }
}
// Decode snapshot storage outside timed work. Response parsing remains inside each replay.
const responses = new Map(Object.entries(cache).map(([url, value]) => [url, { ...value, bytes: Buffer.from(value.body, 'base64') }]));
let conditional = false;
let httpStats;
const replay = async (url, options) => {
    const saved = responses.get(url);
    if (!saved) throw new Error('Missing replay response');
    const tag = new Headers(options.headers).get('If-None-Match');
    httpStats.requests++;
    if (conditional && tag && tag === saved.headers.etag) {
        httpStats.notModified++;
        return new Response(null, { status: 304 });
    }
    httpStats.bodyBytes += saved.bytes.length;
    return new Response(saved.bytes, { status: saved.status, headers: saved.headers });
};
const usableIds = new Set(fetched.filter(row => !row.error).map(row => row.sourceId));
const jobSources = createSources(sources.filter(source => usableIds.has(source.id)), replay);
const runtime = await getPlatformProxy({ configPath: 'wrangler.json', persist: false, remoteBindings: false });
try {
    const db = runtime.env.DB;
    for (const name of (await readdir('drizzle')).filter(n => n.endsWith('.sql')).sort()) {
        const sql = await readFile(`drizzle/${name}`, 'utf8');
        await db.batch(sql.split('--> statement-breakpoint').filter(s => s.trim()).map(s => db.prepare(s)));
    }
    const measured = [];
    async function measure(phase, work) {
        const stats = { statements: 0, rowsRead: 0, rowsWritten: 0, sqlDurationMs: 0 };
        httpStats = { requests: 0, notModified: 0, bodyBytes: 0 };
        const raw = new WeakMap();
        const account = result => {
            stats.statements++;
            stats.rowsRead += result.meta?.rows_read ?? 0;
            stats.rowsWritten += result.meta?.rows_written ?? 0;
            stats.sqlDurationMs += result.meta?.duration ?? 0;
            return result;
        };
        function wrap(statement) {
            const wrapped = {
                bind: (...args) => wrap(statement.bind(...args)),
                all: async () => account(await statement.all()),
                run: async () => account(await statement.run()),
                first: async column => {
                    const result = account(await statement.all());
                    const row = result.results[0] ?? null;
                    return column && row ? row[column] : row;
                },
            };
            raw.set(wrapped, statement); return wrapped;
        }
        const metered = { prepare: sql => wrap(db.prepare(sql)),
            batch: async statements => (await db.batch(statements.map(s => raw.get(s)))).map(account) };
        const cpu = process.cpuUsage();
        const start = performance.now();
        const detail = await work(metered);
        const used = process.cpuUsage(cpu);
        const result = { phase, ...stats, ...httpStats, elapsedMs: Math.round(performance.now() - start),
            nodeCpuMs: +(used.user / 1000 + used.system / 1000).toFixed(3), ...detail };
        measured.push(result);
        console.log(JSON.stringify(result));
    }
    for (const phase of ['baseline', 'full-repeat', 'conditional-repeat']) {
        conditional = phase === 'conditional-repeat';
        // Explicitly reset rotation timestamps outside measurement so every cycle visits all sources.
        await db.prepare("UPDATE source_runs SET last_attempt_at = ''").run();
        await measure(phase, async metered => {
            const report = [];
            for (let i = 0; i < jobSources.length; i++) report.push(...await runCheck(metered, jobSources, { rotate: true }));
            if (report.some(row => row.error)) throw new Error('Replay failed; measurement is incomplete');
            return { invocations: jobSources.length, report };
        });
    }
    const emailEnv = DB => ({ DB, RESEND_API_KEY: 'fake-key-never-sent', EMAIL_FROM: 'alerts@example.com' });
    const settings = { enabled: true, recipient: 'me@example.com', cadence: 'each_check' };
    const sender = async () => 'local-fake-receipt';
    for (const phase of ['email-disabled', 'email-idle', 'email-send']) {
        await saveSettings(emailEnv(db), { ...settings, enabled: phase !== 'email-disabled' });
        if (phase === 'email-send') await queueTestEmail(emailEnv(db));
        await measure(phase, async metered => {
            await deliverNotifications(emailEnv(metered), sender);
            return { invocations: 1 };
        });
    }
    const output = { measuredAt: new Date().toISOString(), snapshot: snapshot ?? null,
        caveat: 'Local Node process CPU includes replay/proxy overhead and excludes emulator subprocess CPU. NOT hosted Worker CPU. Default preferences; source phases replay captured response bodies with simulated conditional responses. Email phases use a fake sender. D1 metadata is local. No saved inbox changes or real emails.',
        fetched, measured };
    await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
    console.log(`Saved ${outputPath}`);
} finally { await runtime.dispose(); }
