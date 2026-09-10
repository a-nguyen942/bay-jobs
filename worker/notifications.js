const DAY = 24 * 60 * 60 * 1000;
// Resend retains keys for 24h. Stop uncertain retries before that expires.
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const iso = (time) => new Date(time).toISOString();
export const validEmail = (value) => value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
export const emailConfigured = (env) => Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM && validEmail(env.EMAIL_FROM));
export class NotificationBusyError extends Error {
    constructor() { super('Email processing is busy. Please try again shortly.'); }
}
class EmailError extends Error {
    retryable;
    constructor(message, retryable) { super(message); this.retryable = retryable; }
}
export const sendEmail = async (payload, id, key) => {
    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': `bay-jobs/${id}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
        throw new EmailError(`Email provider returned HTTP ${response.status}.`, response.status === 429 || response.status === 409 || response.status >= 500);
    const result = await response.json();
    if (typeof result.id !== 'string' || !result.id)
        throw new EmailError('Email provider returned an invalid receipt.', true);
    return result.id;
};
export async function getSettings(db) {
    const row = await db.prepare('SELECT enabled, recipient, cadence, next_digest_at AS nextDigestAt FROM notification_settings WHERE id = 1').first();
    if (!row)
        throw new Error('Notification migration is missing.');
    return { ...row, enabled: Boolean(row.enabled) };
}
async function locked(db, now, work) {
    const token = crypto.randomUUID();
    const lease = await db.prepare(`INSERT INTO notification_lock VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    WHERE notification_lock.expires_at <= ? RETURNING token`).bind(token, iso(now + 180_000), iso(now)).first();
    if (!lease)
        throw new NotificationBusyError();
    try {
        return await work();
    }
    finally {
        await db.prepare('DELETE FROM notification_lock WHERE id = 1 AND token = ?').bind(token).run();
    }
}
export async function saveSettings(env, settings, now = Date.now()) {
    if (settings.enabled && !emailConfigured(env))
        throw new Error('Configure RESEND_API_KEY and EMAIL_FROM on the server before enabling email.');
    return locked(env.DB, now, async () => {
        const previous = await getSettings(env.DB);
        const cancel = !settings.enabled || settings.recipient !== previous.recipient;
        const nextDigest = settings.cadence === 'daily'
            ? previous.enabled && previous.cadence === 'daily' && !cancel ? previous.nextDigestAt : iso(now + DAY)
            : null;
        const statements = [env.DB.prepare('UPDATE notification_settings SET enabled = ?, recipient = ?, cadence = ?, next_digest_at = ? WHERE id = 1')
                .bind(Number(settings.enabled), settings.recipient, settings.cadence, nextDigest)];
        if (cancel) {
            statements.push(env.DB.prepare("UPDATE notification_events SET cancelled = 1 WHERE delivery_id IS NULL"));
            statements.push(env.DB.prepare("UPDATE notification_deliveries SET status = 'cancelled', error = NULL WHERE status IN ('pending', 'sending', 'failed', 'uncertain')"));
        }
        await env.DB.batch(statements);
    });
}
export async function notificationState(env) {
    const [settings, events, counts, history] = await Promise.all([
        getSettings(env.DB),
        env.DB.prepare('SELECT COUNT(*) AS count FROM notification_events WHERE delivery_id IS NULL AND cancelled = 0').first(),
        env.DB.prepare('SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status').all(),
        env.DB.prepare(`SELECT id, job_count AS jobCount, status, attempts, created_at AS createdAt, error,
      CASE WHEN status = 'failed' AND first_attempt_at > ? THEN 1 ELSE 0 END AS canRetry
      FROM notification_deliveries ORDER BY created_at DESC, id DESC LIMIT 10`).bind(iso(Date.now() - RETRY_WINDOW)).all(),
    ]);
    return { settings, configured: emailConfigured(env), queuedJobs: events?.count ?? 0,
        counts: Object.fromEntries(counts.results.map(row => [row.status, row.count])),
        history: history.results.map(row => ({ ...row, canRetry: Boolean(row.canRetry) })) };
}
export async function deliverNotifications(env, sender = sendEmail, clock = Date.now) {
    if (!emailConfigured(env))
        return;
    await locked(env.DB, clock(), async () => {
        const settings = await getSettings(env.DB);
        if (!settings.enabled)
            return;
        const now = clock();
        await env.DB.batch([
            env.DB.prepare(`UPDATE notification_deliveries SET status = 'uncertain', error = 'Retry window expired. Check the provider before sending anything again.'
        WHERE status IN ('pending', 'sending', 'failed') AND first_attempt_at <= ?`).bind(iso(now - RETRY_WINDOW)),
            env.DB.prepare("UPDATE notification_deliveries SET status = 'pending' WHERE status = 'sending' AND lease_until <= ?").bind(iso(now)),
        ]);
        if (settings.cadence === 'each_check' || !settings.nextDigestAt || settings.nextDigestAt <= iso(now)) {
            // Persist the exact email body before calling the provider. Retries reuse it unchanged.
            const events = await env.DB.prepare(`SELECT id, title, company, url FROM notification_events
        WHERE delivery_id IS NULL AND cancelled = 0 ORDER BY created_at, id LIMIT 500`).all();
            for (let start = 0; start < events.results.length; start += 50) {
                const chunk = events.results.slice(start, start + 50);
                const id = crypto.randomUUID();
                const payload = { from: env.EMAIL_FROM, to: [settings.recipient],
                    subject: `Bay Jobs: ${chunk.length} new ${chunk.length === 1 ? 'match' : 'matches'}`,
                    text: `New matches discovered by your Bay Jobs monitor:\n\n${chunk.map(job => `${job.title}\n${job.company}\n${job.url}`).join('\n\n')}\n\nApply on the employer’s website and track your status in Bay Jobs. These are newly discovered listings, not necessarily newly posted jobs.` };
                await env.DB.batch([
                    env.DB.prepare("INSERT INTO notification_deliveries (id, payload, job_count, status, created_at, next_attempt_at) VALUES (?, ?, ?, 'pending', ?, ?)").bind(id, JSON.stringify(payload), chunk.length, iso(now), iso(now)),
                    env.DB.prepare(`UPDATE notification_events SET delivery_id = ? WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(id, ...chunk.map(job => job.id)),
                ]);
            }
            if (settings.cadence === 'daily')
                await env.DB.prepare(`UPDATE notification_settings SET next_digest_at = ? WHERE id = 1
        AND NOT EXISTS (SELECT 1 FROM notification_events WHERE delivery_id IS NULL AND cancelled = 0)`).bind(iso(now + DAY)).run();
        }
        // Bound outbound requests so the worker stays within its lease and execution budget.
        for (let index = 0; index < 5; index++) {
            const time = clock();
            const row = await env.DB.prepare(`UPDATE notification_deliveries SET status = 'sending', attempts = attempts + 1,
        first_attempt_at = COALESCE(first_attempt_at, ?), lease_until = ?
        WHERE id = (SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at, id LIMIT 1)
        RETURNING id, payload, attempts, first_attempt_at`).bind(iso(time), iso(time + 60_000), iso(time)).first();
            if (!row)
                break;
            try {
                const providerId = await sender(JSON.parse(row.payload), row.id, env.RESEND_API_KEY);
                await env.DB.prepare("UPDATE notification_deliveries SET status = 'sent', provider_id = ?, error = NULL, lease_until = NULL WHERE id = ?").bind(providerId, row.id).run();
            }
            catch (error) {
                const retryable = !(error instanceof EmailError) || error.retryable;
                const failed = !retryable || row.attempts >= 5;
                // Do not store arbitrary network errors that could contain credentials or request details.
                const message = error instanceof EmailError ? error.message : 'Email delivery could not be confirmed. A safe retry will reuse the same email ID.';
                const delay = [60_000, 300_000, 1_800_000, 7_200_000][Math.min(row.attempts - 1, 3)];
                await env.DB.prepare('UPDATE notification_deliveries SET status = ?, error = ?, next_attempt_at = ?, lease_until = NULL WHERE id = ?')
                    .bind(failed ? 'failed' : 'pending', message, iso(time + delay), row.id).run();
            }
        }
    });
}
export async function retryNotifications(env, now = Date.now()) {
    await locked(env.DB, now, async () => {
        const settings = await getSettings(env.DB);
        if (!settings.enabled || !emailConfigured(env))
            throw new Error('Enable and configure email before retrying.');
        await env.DB.prepare(`UPDATE notification_deliveries SET status = 'pending', next_attempt_at = ?
      WHERE status = 'failed' AND first_attempt_at > ?`).bind(iso(now), iso(now - RETRY_WINDOW)).run();
    });
}
