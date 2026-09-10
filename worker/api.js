import { listJobs, JOB_COLUMNS, toJob } from '../db/jobs.js';
import { sources } from '../config/sources.js';
import { APPLICATION_STATUSES, JOB_VIEWS } from '../lib/constants.js';
import { runCheck, CheckInProgressError } from './check.js';
import { getSettings } from './notifications.js';
export async function postCheck(request, db, jobSources) {
    if (request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    try {
        const report = await runCheck(db, jobSources);
        return Response.json({ report }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        if (error instanceof CheckInProgressError)
            return Response.json({ error: error.message }, { status: 409 });
        console.error('Source check failed:', error);
        return Response.json({ error: 'Could not check sources. Verify the database migrations and try again.' }, { status: 503 });
    }
}
export async function getJobs(request, db) {
    const params = new URL(request.url).searchParams;
    const view = params.get('view') ?? 'all';
    const query = (params.get('q') ?? '').trim();
    const page = params.get('page') ?? '1';
    if (!JOB_VIEWS.includes(view) || !/^[1-9]\d*$/.test(page) || Number(page) > 1_000_000 || query.length > 200) {
        return Response.json({ error: 'Invalid inbox query' }, { status: 400 });
    }
    try {
        const [jobs, run, errors, notifications] = await Promise.all([
            listJobs(db, { view: view, query, page: Number(page) }),
            db.prepare('SELECT MAX(last_success_at) AS lastCheckedAt FROM source_runs').first(),
            db.prepare('SELECT source_id AS sourceId, error FROM source_runs WHERE error IS NOT NULL').all(),
            getSettings(db),
        ]);
        return Response.json({ ...jobs, monitor: { sourceCount: sources.length, lastCheckedAt: run?.lastCheckedAt ?? null, notificationMode: notifications.enabled ? 'email' : 'disabled', errors: errors.results } }, { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        console.error('Inbox could not load:', error);
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
    const patch = body;
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !['seen', 'applicationStatus'].includes(key)) ||
        ('seen' in patch && typeof patch.seen !== 'boolean') ||
        ('applicationStatus' in patch && !APPLICATION_STATUSES.includes(patch.applicationStatus))) {
        return Response.json({ error: 'Invalid update' }, { status: 400 });
    }
    const clauses = [];
    const values = [];
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
        console.error('Job update failed:', error);
        return Response.json({ error: 'Could not save job' }, { status: 503 });
    }
}
