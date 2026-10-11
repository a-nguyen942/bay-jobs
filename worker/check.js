import { hourStart } from '../lib/scan-summary.js';
import { checkSources } from './monitor.js';
import { reserveWork } from './cpu-budget.js';
export class CheckInProgressError extends Error {
    constructor() { super('A source check is already running. Try again shortly.'); }
}
export const MANUAL_COOLDOWN_MS = 5 * 60_000;
export class CheckCooldownError extends Error {
    constructor(retryAfter) {
        super(`Please wait ${retryAfter} seconds before checking sources again.`);
        this.retryAfter = retryAfter;
    }
}
/** One lease in D1 protects manual and cron checks; an interrupted run expires. */
export async function runCheck(db, sources, { manual = false, rotate = false, recovery = false, clock = Date.now } = {}) {
    return withCheckLock(db, rotate || recovery ? 1 : sources.length, clock, async now => {
        const active = await db.prepare('SELECT token FROM manual_scans WHERE id = 1 AND expires_at > ? AND next_index < json_array_length(source_ids)').bind(now.toISOString()).first();
        if (active) throw new CheckInProgressError();
        if (manual) await reserveManualCheck(db, now.getTime());
        let selected = sources;
        if (recovery) {
            const start = hourStart(now.getTime());
            const history = await db.prepare(`SELECT source_id, last_attempt_at, last_success_at, error FROM source_runs`).all();
            const retried = await db.prepare('SELECT source_id FROM scan_retries WHERE hour_start = ?').bind(start).all();
            const excluded = new Set(retried.results.map(row => row.source_id));
            const runs = new Map(history.results.map(row => [row.source_id, row]));
            const candidates = sources.filter(source => {
                const run = runs.get(source.id);
                return !excluded.has(source.id) && (!run || run.last_attempt_at < start || run.error || !run.last_success_at || run.last_success_at < start);
            });
            // Missing checks go first, then failed checks in oldest-attempt order.
            candidates.sort((a, b) => (runs.get(a.id)?.last_attempt_at ?? '').localeCompare(runs.get(b.id)?.last_attempt_at ?? ''));
            if (!candidates.length) return [];
            selected = [candidates[0]];
            await db.prepare('INSERT INTO scan_retries (hour_start, source_id) VALUES (?, ?)').bind(start, selected[0].id).run();
        }
        else if (rotate && sources.length) {
            const history = await db.prepare('SELECT source_id, last_attempt_at FROM source_runs').all();
            const attempts = new Map(history.results.map(row => [row.source_id, row.last_attempt_at]));
            // Config order breaks ties; failures also advance the rotation.
            selected = [sources.reduce((oldest, source) =>
                (attempts.get(source.id) ?? '') < (attempts.get(oldest.id) ?? '') ? source : oldest)];
        }
        return await checkSources(db, selected, { recovery });
    });
}


async function withCheckLock(db, sourceCount, clock, work) {
    const token = crypto.randomUUID();
    const now = new Date(clock());
    const expiresAt = new Date(now.getTime() + Math.max(300_000, sourceCount * 60_000)).toISOString();
    const lease = await db.prepare(`INSERT INTO monitor_lock (id, token, expires_at) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE monitor_lock.expires_at <= ? RETURNING token`).bind(token, expiresAt, now.toISOString()).first();
    if (!lease) throw new CheckInProgressError();
    try { return await work(now); }
    finally { await db.prepare('DELETE FROM monitor_lock WHERE id = 1 AND token = ?').bind(token).run(); }
}
async function reserveManualCheck(db, now) {
    const reserved = await db.prepare(`INSERT INTO manual_check_budget VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET next_allowed_at = excluded.next_allowed_at
        WHERE manual_check_budget.next_allowed_at <= ? RETURNING next_allowed_at`)
        .bind(now + MANUAL_COOLDOWN_MS, now).first();
    if (!reserved) {
        const budget = await db.prepare('SELECT next_allowed_at FROM manual_check_budget WHERE id = 1').first();
        throw new CheckCooldownError(Math.max(1, Math.ceil((budget.next_allowed_at - now) / 1000)));
    }
    await reserveWork(db, now, { manualStart: true });
}
export class ManualScanError extends Error {}
const SCAN_IDLE_MS = 120_000;
function scanState(row, sources) {
    const ids = JSON.parse(row.source_ids);
    return { token: row.token, total: ids.length, nextIndex: row.next_index, report: JSON.parse(row.report),
        done: row.next_index >= ids.length, nextSourceLabel: sources.find(source => source.id === ids[row.next_index])?.label ?? null };
}
export async function startManualScan(db, sources, clock = Date.now) {
    return withCheckLock(db, 1, clock, async now => {
        const existing = await db.prepare('SELECT * FROM manual_scans WHERE id = 1').first();
        if (existing && existing.expires_at > now.toISOString() && existing.next_index < JSON.parse(existing.source_ids).length)
            throw new CheckInProgressError();
        await reserveManualCheck(db, now.getTime());
        const row = { token: crypto.randomUUID(), source_ids: JSON.stringify(sources.map(source => source.id)), next_index: 0, report: '[]' };
        await db.prepare(`INSERT INTO manual_scans (id, token, source_ids, next_index, report, expires_at)
            VALUES (1, ?, ?, 0, '[]', ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token,
            source_ids = excluded.source_ids, next_index = 0, report = '[]', expires_at = excluded.expires_at`)
            .bind(row.token, row.source_ids, new Date(now.getTime() + SCAN_IDLE_MS).toISOString()).run();
        return scanState(row, sources);
    });
}
export async function stepManualScan(db, sources, token, index, clock = Date.now) {
    return withCheckLock(db, 1, clock, async now => {
        const row = await db.prepare('SELECT * FROM manual_scans WHERE id = 1 AND token = ?').bind(token).first();
        if (!row || row.expires_at <= now.toISOString()) throw new ManualScanError('Manual scan expired. Keep the tab open and start another scan when the cooldown ends.');
        if (index > row.next_index) throw new ManualScanError('Invalid scan step. Refresh and start another scan.');
        const ids = JSON.parse(row.source_ids);
        // Retrying a completed step returns its saved result without refetching.
        if (index < row.next_index || row.next_index >= ids.length) return scanState(row, sources);
        const source = sources.find(source => source.id === ids[index]);
        const report = source ? await checkSources(db, [source])
            : [{ sourceId: ids[index], inserted: 0, matched: 0, error: 'Source configuration changed during scan' }];
        row.next_index++;
        row.report = JSON.stringify([...JSON.parse(row.report), ...report]);
        await db.prepare('UPDATE manual_scans SET next_index = ?, report = ?, expires_at = ? WHERE id = 1 AND token = ?')
            .bind(row.next_index, row.report, new Date(clock() + SCAN_IDLE_MS).toISOString(), token).run();
        return scanState(row, sources);
    });
}
