import { hourStart, scanSummary } from '../lib/scan-summary.js';
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export function validPingUrl(value) {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'hc-ping.com' && !url.port && !url.username && !url.password && !url.search && !url.hash
            && /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(url.pathname);
    } catch { return false; }
}
export async function watchdogApi(request, db) {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST') {
        if (request.headers.get('Origin') !== new URL(request.url).origin) return json({ error: 'Invalid origin' }, 403);
        let body;
        try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('pingUrl' in body)
            || (body.pingUrl !== null && !validPingUrl(body.pingUrl))) return json({ error: 'Use the HTTPS hc-ping.com URL ending in your check’s UUID.' }, 400);
        await db.prepare('UPDATE watchdog_settings SET ping_url = ?, last_ping_at = NULL, error = NULL WHERE id = 1').bind(body.pingUrl).run();
    }
    const row = await db.prepare('SELECT ping_url IS NOT NULL AS configured, last_ping_at AS lastPingAt, error FROM watchdog_settings WHERE id = 1').first();
    return json({ ...row, configured: Boolean(row.configured) });
}
export async function pingWatchdog(db, sources, now = Date.now(), request = fetch) {
    const row = await db.prepare('SELECT * FROM watchdog_settings WHERE id = 1').first();
    if (!row?.ping_url || !validPingUrl(row.ping_url) || row.last_ping_at >= hourStart(now)) return;
    const results = await db.prepare('SELECT source_id AS sourceId, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, error FROM source_runs').all();
    const health = sources.map(source => ({ ...results.results.find(run => run.sourceId === source.id), sourceId: source.id, label: source.label }));
    if (scanSummary(health, 0, now).status !== 'complete') return;
    try {
        // No listing data, recipient addresses, or app credentials leave the Worker.
        const response = await request(row.ping_url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('Heartbeat rejected');
        await db.prepare('UPDATE watchdog_settings SET last_ping_at = ?, error = NULL WHERE id = 1 AND ping_url = ?')
            .bind(new Date(now).toISOString(), row.ping_url).run();
    } catch {
        await db.prepare("UPDATE watchdog_settings SET error = 'The external monitor did not confirm the heartbeat.' WHERE id = 1 AND ping_url = ?").bind(row.ping_url).run();
    }
}
