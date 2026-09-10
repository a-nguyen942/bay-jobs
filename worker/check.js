import { checkSources } from './monitor.js';
export class CheckInProgressError extends Error {
    constructor() { super('A source check is already running. Try again shortly.'); }
}
/** One lease in D1 protects manual and cron checks; an interrupted run expires. */
export async function runCheck(db, sources) {
    const token = crypto.randomUUID();
    const now = new Date();
    // Each board has a 15s request timeout. Allow additional time for DB writes.
    const expiresAt = new Date(now.getTime() + Math.max(300_000, sources.length * 60_000)).toISOString();
    const lease = await db.prepare(`INSERT INTO monitor_lock (id, token, expires_at) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE monitor_lock.expires_at <= ? RETURNING token`).bind(token, expiresAt, now.toISOString()).first();
    if (!lease)
        throw new CheckInProgressError();
    try {
        return await checkSources(db, sources);
    }
    finally {
        await db.prepare('DELETE FROM monitor_lock WHERE id = 1 AND token = ?').bind(token).run();
    }
}
