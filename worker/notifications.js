import { coverageReport, pacificDay } from './coverage.js';
import { sources as sourceConfigs } from '../config/sources.js';
import { createSources } from './sources/index.js';
import { hourStart, scanSummary } from '../lib/scan-summary.js';
import { emailBudget, reserveEmailAttempt } from './email-budget.js';
const pacificDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY = 24 * 60 * 60 * 1000;
// Resend retains keys for 24h. Stop uncertain retries before that expires.
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const iso = (time) => new Date(time).toISOString();
export const validEmail = (value) => typeof value === 'string' && value.length <= 254 && !/[\p{Cc}\p{Cf}]/u.test(value) && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
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
    const row = await db.prepare('SELECT enabled, recipient, cadence, next_digest_at AS nextDigestAt, skill_filter AS skillFilter, skill_mask AS skillMask, skill_mode AS skillMode, internships_only AS internshipsOnly, scan_alerts AS scanAlerts FROM notification_settings WHERE id = 1').first();
    if (!row)
        throw new Error('Notification migration is missing.');
    return { ...row, enabled: Boolean(row.enabled), skillFilter: Boolean(row.skillFilter), internshipsOnly: Boolean(row.internshipsOnly), scanAlerts: Boolean(row.scanAlerts) };
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
        const statements = [env.DB.prepare('UPDATE notification_settings SET enabled = ?, recipient = ?, cadence = ?, next_digest_at = ?, skill_filter = ?, skill_mask = ?, skill_mode = ?, internships_only = ?, scan_alerts = ? WHERE id = 1')
                .bind(Number(settings.enabled), settings.recipient, settings.cadence, nextDigest, Number(settings.skillFilter ?? previous.skillFilter), settings.skillMask ?? previous.skillMask, settings.skillMode ?? previous.skillMode, Number(settings.internshipsOnly ?? previous.internshipsOnly), Number(settings.scanAlerts ?? previous.scanAlerts))];
        if (settings.scanAlerts === false) statements.push(env.DB.prepare("UPDATE notification_deliveries SET status = 'cancelled', error = NULL WHERE kind = 'scan_alert' AND status IN ('pending', 'sending', 'failed', 'uncertain')"));
        if (cancel) {
            statements.push(env.DB.prepare("UPDATE notification_events SET cancelled = 1 WHERE delivery_id IS NULL"));
            statements.push(env.DB.prepare("UPDATE notification_deliveries SET status = 'cancelled', error = NULL WHERE status IN ('pending', 'sending', 'failed', 'uncertain')"));
        }
        await env.DB.batch(statements);
    });
}
export async function notificationState(env) {
    const [settings, events, counts, history, budget] = await Promise.all([
        getSettings(env.DB),
        env.DB.prepare('SELECT COUNT(*) AS count FROM notification_events WHERE delivery_id IS NULL AND cancelled = 0').first(),
        env.DB.prepare('SELECT status, COUNT(*) AS count FROM notification_deliveries GROUP BY status').all(),
        env.DB.prepare(`SELECT id, kind, job_count AS jobCount, status, attempts, created_at AS createdAt, error,
      CASE WHEN status = 'failed' AND first_attempt_at > ? THEN 1 ELSE 0 END AS canRetry
      FROM notification_deliveries ORDER BY created_at DESC, id DESC LIMIT 10`).bind(iso(Date.now() - RETRY_WINDOW)).all(),
        emailBudget(env.DB),
    ]);
    return { budget, settings, configured: emailConfigured(env), queuedJobs: events?.count ?? 0,
        counts: Object.fromEntries(counts.results.map(row => [row.status, row.count])),
        history: history.results.map(row => ({ ...row, canRetry: Boolean(row.canRetry) })) };
}
export async function deliverNotifications(env, sender = sendEmail, clock = Date.now) {
    if (!emailConfigured(env))
        return;
    // Idle checks need no lease or writes. All actual work still rechecks settings
    // under the existing lease; work arriving after this read waits for the next pass.
    const checkedAt = clock();
    const ready = await env.DB.prepare(`SELECT enabled,
        EXISTS (SELECT 1 FROM notification_lock WHERE id = 1 AND expires_at > ?) AS busy,
        CASE WHEN enabled = 0 THEN 0 ELSE (
            (cadence = 'daily' AND (next_digest_at IS NULL OR next_digest_at <= ?))
            OR ((cadence = 'each_check' OR next_digest_at IS NULL OR next_digest_at <= ?)
                AND EXISTS (SELECT 1 FROM notification_events WHERE delivery_id IS NULL AND cancelled = 0))
            OR EXISTS (SELECT 1 FROM notification_deliveries WHERE
                (status = 'pending' AND next_attempt_at <= ?)
                OR (status = 'sending' AND lease_until <= ?)
                OR (status IN ('pending', 'sending', 'failed') AND first_attempt_at <= ?))
            OR EXISTS (SELECT 1 FROM email_attempt_budget WHERE attempted_at <= ?)
        ) END AS due
        FROM notification_settings WHERE id = 1`)
        .bind(iso(checkedAt), iso(checkedAt), iso(checkedAt), iso(checkedAt), iso(checkedAt),
            iso(checkedAt - RETRY_WINDOW), checkedAt - 31 * DAY).first();
    if (!ready) throw new Error('Notification migration is missing.');
    if (ready.busy) throw new NotificationBusyError();
    if (!ready.due) return;
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
            // A daily summary is one bounded, durable email. Excess new matches stay
            // queued for the next day; reminders never affect discovery or skill filters.
            const daily = settings.cadence === 'daily';
            const events = await env.DB.prepare(`SELECT id, title, company, url FROM notification_events
                WHERE delivery_id IS NULL AND cancelled = 0 ORDER BY created_at, id LIMIT 50`).all();
            const today = daily ? pacificDate.format(new Date(now)) : iso(now).slice(0, 10);
            const through = new Date(`${today}T12:00:00Z`);
            through.setUTCDate(through.getUTCDate() + 7);
            const reminders = daily ? (await env.DB.prepare(`SELECT title, company, canonical_url AS url,
                    follow_up_date AS followUpDate, deadline_date AS deadlineDate, application_status AS applicationStatus
                FROM jobs WHERE is_demo = 0 AND application_status NOT IN ('archived', 'rejected')
                AND ((follow_up_date IS NOT NULL AND follow_up_date <= ?)
                    OR (application_status = 'considering' AND deadline_date IS NOT NULL AND deadline_date <= ?))
                ORDER BY MIN(COALESCE(follow_up_date, '9999-12-31'),
                    CASE WHEN application_status = 'considering' THEN COALESCE(deadline_date, '9999-12-31') ELSE '9999-12-31' END), id LIMIT 20`)
                .bind(through.toISOString().slice(0, 10), through.toISOString().slice(0, 10)).all()).results : [];
            const chunk = events.results;
            const statements = [];
            if (chunk.length || reminders.length || daily) {
                const coverage = daily ? await coverageReport(env.DB, createSources(sourceConfigs), pacificDay(Date.parse(`${today}T12:00:00Z`) - DAY), now) : null;
                const coverageText = coverage ? `\n\nCoverage for ${coverage.day} (Pacific): ${coverage.checked}/${coverage.total} sources checked; ${coverage.totals.successes} successful checks; ${coverage.totals.failures} failed checks; ${coverage.totals.recovered} successful recovery checks; ${coverage.totals.discovered} newly saved listings; ${coverage.totals.filtered} rejected internship observations. Repeated observations are counted per download. Overdue now: ${coverage.overdue.join(', ') || 'none'}. History begins ${coverage.recordingSince ?? 'when the first check completes'}. Open Daily coverage for source details.` : '';
                const id = crypto.randomUUID();
                const reminderText = reminders.map(job => `${job.title} — ${job.company}\n${[
                    job.followUpDate && job.followUpDate <= through.toISOString().slice(0, 10) ? `Follow up: ${job.followUpDate}${job.followUpDate < today ? ' (overdue)' : ''}` : '',
                    job.applicationStatus === 'considering' && job.deadlineDate && job.deadlineDate <= through.toISOString().slice(0, 10) ? `Apply by: ${job.deadlineDate}${job.deadlineDate < today ? ' (deadline passed)' : ''}` : '',
                ].filter(Boolean).join(' · ')}\n${job.url}`).join('\n\n');
                const payload = { from: env.EMAIL_FROM, to: [settings.recipient],
                    subject: daily ? `Bay Jobs: daily summary — ${chunk.length} new matches, ${reminders.length} reminders`
                        : `Bay Jobs: ${chunk.length} new ${chunk.length === 1 ? 'match' : 'matches'}`,
                    text: `New matches discovered by your Bay Jobs monitor:\n\n${chunk.length ? chunk.map(job => `${job.title}\n${job.company}\n${job.url}`).join('\n\n') : 'No new matches.'}${daily ? `\n\nFollow-ups and deadlines (overdue or within 7 days, Pacific dates):\n\n${reminderText || 'No upcoming reminders.'}\n\nUp to 50 new matches and 20 reminders per summary. Additional matches remain queued for the next daily summary; check the app for all reminders.` : ''}${coverageText}\n\nApply on the employer’s website and track your status in Bay Jobs. These are newly discovered listings, not necessarily newly posted jobs.` };
                statements.push(env.DB.prepare("INSERT INTO notification_deliveries (id, payload, job_count, kind, status, created_at, next_attempt_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
                    .bind(id, JSON.stringify(payload), chunk.length, daily ? 'digest' : 'matches', iso(now), iso(now)));
                if (chunk.length) statements.push(env.DB.prepare(`UPDATE notification_events SET delivery_id = ? WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(id, ...chunk.map(job => job.id)));
            }
            // Commit the summary and its next due time together, including reminder-only days.
            if (daily) statements.push(env.DB.prepare('UPDATE notification_settings SET next_digest_at = ? WHERE id = 1').bind(iso(now + DAY)));
            if (statements.length) await env.DB.batch(statements);
        }
        await env.DB.prepare('DELETE FROM email_attempt_budget WHERE attempted_at <= ?').bind(now - 31 * DAY).run();
        // Bound outbound requests so the worker stays within its lease and execution budget.
        for (let index = 0; index < 1; index++) {
            const time = clock();
            const pending = await env.DB.prepare("SELECT id FROM notification_deliveries WHERE status = 'pending' AND next_attempt_at <= ? LIMIT 1").bind(iso(time)).first();
            if (!pending || !await reserveEmailAttempt(env.DB, time)) break;
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

export async function queueTestEmail(env, now = Date.now()) {
    if (!emailConfigured(env)) throw new Error('Configure RESEND_API_KEY and EMAIL_FROM before testing email.');
    return locked(env.DB, now, async () => {
        const settings = await getSettings(env.DB);
        if (!settings.enabled || !validEmail(settings.recipient)) throw new Error('Enable and configure email before testing.');
        // Repeated clicks within a minute reuse the same frozen message.
        const recent = await env.DB.prepare(`SELECT id FROM notification_deliveries
            WHERE kind = 'test' AND created_at > ? AND status != 'cancelled' ORDER BY created_at DESC LIMIT 1`)
            .bind(iso(now - 60_000)).first();
        if (recent) return recent.id;
        const id = crypto.randomUUID();
        const payload = { from: env.EMAIL_FROM, to: [settings.recipient], subject: 'Bay Jobs: test notification',
            text: 'Your Bay Jobs email connection is working. New matching jobs will use your saved notification schedule. You still apply on the employer’s website yourself.' };
        await env.DB.prepare(`INSERT INTO notification_deliveries (id, payload, job_count, kind, status, created_at, next_attempt_at)
            VALUES (?, ?, 0, 'test', 'pending', ?, ?)`)
            .bind(id, JSON.stringify(payload), iso(now), iso(now)).run();
        return id;
    });
}

/** One durable warning per incomplete hour, using the existing email queue/budget. */
export async function queueScanAlert(env, sources, now = Date.now()) {
    if (!sources.length) return;
    const start = hourStart(now);
    if (now - Date.parse(start) < sources.length * 2 * 60_000) return;
    // Retain a short audit window without growing retry state indefinitely.
    await env.DB.prepare('DELETE FROM scan_retries WHERE hour_start < ?').bind(hourStart(now - 2 * DAY)).run();
    if (!emailConfigured(env)) return;
    await locked(env.DB, now, async () => {
        const settings = await getSettings(env.DB);
        if (!settings.enabled || !settings.scanAlerts) return;
        const rows = await env.DB.prepare(`SELECT source_id AS sourceId, last_attempt_at AS lastAttemptAt,
            last_success_at AS lastSuccessAt, error FROM source_runs`).all();
        const runs = new Map(rows.results.map(row => [row.sourceId, row]));
        const health = sources.map(source => ({ ...runs.get(source.id), sourceId: source.id, label: source.label }));
        const summary = scanSummary(health, 0, now);
        if (summary.status === 'complete') return;
        const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short' }).format(new Date(start));
        const payload = { from: env.EMAIL_FROM, to: [settings.recipient],
            subject: `Bay Jobs: incomplete source scan — ${stamp}`,
            text: `The ${stamp} scan is still incomplete after the recovery window. ${summary.succeeded}/${summary.total} sources have a successful latest check.\n\n${summary.failedSources.length ? `Failed: ${summary.failedSources.join(', ')}.\n` : ''}${summary.waitingSources.length ? `Missing results: ${summary.waitingSources.join(', ')}.\n` : ''}\nSome listings may be missing. Open Bay Jobs to review source health or run Check all sources. This snapshot can change if a later check succeeds. Automatic checks continue next hour.` };
        await env.DB.prepare(`INSERT INTO notification_deliveries (id, payload, job_count, kind, status, created_at, next_attempt_at)
            VALUES (?, ?, 0, 'scan_alert', 'pending', ?, ?) ON CONFLICT(id) DO NOTHING`)
            .bind(`scan-alert:${start}`, JSON.stringify(payload), iso(now), iso(now)).run();
    });
}
