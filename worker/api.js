import { textKey, searchKey, tokenKey } from '../lib/text.js';
import { cpuBudget, CpuBudgetError } from './cpu-budget.js';
import { hourStart, scanSummary } from '../lib/scan-summary.js';
import { ALL_SKILLS } from '../lib/skills.js';
import { listJobs, JOB_COLUMNS, toJob } from '../db/jobs.js';
import { sources } from '../config/sources.js';
import { APPLICATION_STATUSES, JOB_VIEWS } from '../lib/constants.js';
import { runCheck, startManualScan, stepManualScan, ManualScanError, CheckInProgressError, CheckCooldownError } from './check.js';
import { getSettings } from './notifications.js';
import { createSources } from './sources/index.js';
import { validDate } from '../lib/dates.js';
export async function postCheck(request, db, jobSources) {
    if (request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    let body = null;
    const raw = await request.text();
    if (raw) {
        try { body = JSON.parse(raw); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
        if (body && typeof body === 'object' && !Array.isArray(body)) body.action = tokenKey(body.action);
        if (!body || typeof body !== 'object' || Array.isArray(body)
            || !['start', 'step'].includes(body.action)
            || Object.keys(body).some(key => !(body.action === 'start' ? ['action'] : ['action', 'token', 'index']).includes(key))
            || (body.action === 'step' && (typeof body.token !== 'string' || body.token.length > 100 || !Number.isInteger(body.index) || body.index < 0 || body.index > 1000)))
            return Response.json({ error: 'Invalid scan request' }, { status: 400 });
    }
    try {
        if (body) {
            const scan = body.action === 'start' ? await startManualScan(db, jobSources)
                : await stepManualScan(db, jobSources, body.token, body.index);
            return Response.json({ scan }, { headers: { 'Cache-Control': 'no-store' } });
        }
        // Preserve the old one-source endpoint for already-open clients.
        const report = await runCheck(db, jobSources, { manual: true, rotate: true });
        return Response.json({ report }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        if (error instanceof CpuBudgetError)
            return Response.json({ error: error.message }, { status: 429, headers: { 'Retry-After': String(error.retryAfter), 'Cache-Control': 'no-store' } });
        if (error instanceof ManualScanError) return Response.json({ error: error.message }, { status: 400 });
        if (error instanceof CheckCooldownError)
            return Response.json({ error: error.message, retryAfter: error.retryAfter },
                { status: 429, headers: { 'Retry-After': String(error.retryAfter), 'Cache-Control': 'no-store' } });
        if (error instanceof CheckInProgressError)
            return Response.json({ error: error.message }, { status: 409 });
        console.error('Source check failed; request details omitted.');
        return Response.json({ error: 'Could not check sources. Verify the database migrations and try again.' }, { status: 503 });
    }
}
export async function getJobs(request, db, jobSources = createSources(sources)) {
    const params = new URL(request.url).searchParams;
    const view = tokenKey(params.get('view') ?? 'all');
    const query = searchKey(params.get('q') ?? '');
    const page = tokenKey(params.get('page') ?? '1');
    const sort = tokenKey(params.get('sort') ?? 'newest');
    const skillMode = tokenKey(params.get('skillMode') ?? 'off');
    const skills = tokenKey(params.get('skills') ?? '0');
    const hideClosed = tokenKey(params.get('hideClosed') ?? 'false');
    const internships = tokenKey(params.get('internships') ?? 'false');
    if (!['true', 'false'].includes(hideClosed) || !['newest', 'importance', 'deadline'].includes(sort) || !['off', 'any', 'all'].includes(skillMode)
        || !/^\d{1,2}$/.test(skills) || Number(skills) > ALL_SKILLS || !['true', 'false'].includes(internships))
        return Response.json({ error: 'Invalid skill filters' }, { status: 400 });
    if (!JOB_VIEWS.includes(view) || !/^[1-9]\d*$/.test(page) || Number(page) > 1_000_000 || query.length > 200) {
        return Response.json({ error: 'Invalid inbox query' }, { status: 400 });
    }
    try {
        const now = Date.now();
        const [jobs, runs, notifications, discoveries, integrity, safety] = await Promise.all([
            listJobs(db, { view: view, query, page: Number(page), sort, skillMode, skills: Number(skills), internships: internships === 'true', hideClosed: hideClosed === 'true' }),
            db.prepare('SELECT source_id AS sourceId, last_attempt_at AS lastAttemptAt, last_success_at AS lastSuccessAt, matched_count AS matchedCount, consecutive_failures AS consecutiveFailures, error FROM source_runs').all(),
            getSettings(db),
            db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE first_found_at >= ? AND first_found_at <= ?
                AND is_demo = 0 AND source_label IN (SELECT value FROM json_each(?))`)
                .bind(hourStart(now), new Date(now).toISOString(), JSON.stringify(jobSources.map(source => source.label))).first(),
            db.prepare('SELECT source_id, warning, allow_next FROM source_integrity WHERE warning IS NOT NULL').all(),
            cpuBudget(db, now),
        ]);
        const health = jobSources.map(source => {
            const run = runs.results.find(row => row.sourceId === source.id);
            const held = integrity.results.find(row => row.source_id === source.id);
            return { sourceId: source.id, label: source.label, integrityWarning: held?.warning ?? null, acceptPending: Boolean(held?.allow_next), lastAttemptAt: run?.lastAttemptAt ?? null,
                lastSuccessAt: run?.lastSuccessAt ?? null, matchedCount: run?.matchedCount ?? 0, error: run?.error ?? null, consecutiveFailures: run?.consecutiveFailures ?? 0 };
        });
        const lastCheckedAt = health.map(source => source.lastSuccessAt).filter(Boolean).sort().at(-1) ?? null;
        return Response.json({ ...jobs, monitor: { sourceCount: health.length, lastCheckedAt, scan: scanSummary(health, discoveries.total, now),
            notificationMode: notifications.enabled ? 'email' : 'disabled', sources: health, safety,
            errors: health.filter(source => source.error).map(({ sourceId, error }) => ({ sourceId, error })) } },
            { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        console.error('Inbox could not load; database details omitted.');
        return Response.json({ error: 'Database unavailable. Run npm run db:migrate locally.' }, { status: 503 });
    }
}
export async function patchJob(request, db, id) {
    // Reject cross-origin writes. Hosting must also provide owner authentication.
    if (request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    let body;
    try {
        body = await request.json();
    }
    catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
        return Response.json({ error: 'Invalid update' }, { status: 400 });
    const patch = { ...body };
    if ('applicationStatus' in patch) patch.applicationStatus = tokenKey(patch.applicationStatus);
    for (const key of ['deadlineDate', 'followUpDate'])
        if (typeof patch[key] === 'string') patch[key] = textKey(patch[key]);
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !['seen', 'applicationStatus', 'notes', 'followUpDate', 'isFavorite', 'deadlineDate'].includes(key)) ||
        ('isFavorite' in patch && typeof patch.isFavorite !== 'boolean') ||
        ('deadlineDate' in patch && patch.deadlineDate !== null && !validDate(patch.deadlineDate)) ||
        ('notes' in patch && (typeof patch.notes !== 'string' || patch.notes.length > 10000)) ||
        ('followUpDate' in patch && patch.followUpDate !== null && !validDate(patch.followUpDate)) ||
        ('seen' in patch && typeof patch.seen !== 'boolean') ||
        ('applicationStatus' in patch && !APPLICATION_STATUSES.includes(patch.applicationStatus))) {
        return Response.json({ error: 'Invalid update' }, { status: 400 });
    }
    const clauses = [];
    const values = [];
    if ('isFavorite' in patch) { clauses.push('is_favorite = ?'); values.push(Number(patch.isFavorite)); }
    if ('deadlineDate' in patch) { clauses.push('deadline_date = ?'); values.push(patch.deadlineDate); }
    if ('notes' in patch) { clauses.push('notes = ?'); values.push(patch.notes); }
    if ('followUpDate' in patch) { clauses.push('follow_up_date = ?'); values.push(patch.followUpDate); }
    if ('seen' in patch) {
        clauses.push('seen_at = ?');
        values.push(patch.seen ? new Date().toISOString() : null);
    }
    if ('applicationStatus' in patch) {
        clauses.push('application_status = ?');
        values.push(patch.applicationStatus);
    }
    try {
        const row = await db.prepare(`UPDATE jobs SET ${clauses.join(', ')} WHERE id = ? RETURNING ${JOB_COLUMNS}`).bind(...values, id).first();
        if (!row)
            return Response.json({ error: 'Job not found' }, { status: 404 });
        return Response.json(toJob(row), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        console.error('Job update failed; request details omitted.');
        return Response.json({ error: 'Could not save job' }, { status: 503 });
    }
}
