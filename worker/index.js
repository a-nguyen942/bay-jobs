import { runAggregators, aggregatorStatus } from './aggregators.js';
import { coverageApi, cleanCoverage } from './coverage.js';
import { watchdogApi, pingWatchdog } from './watchdog.js';
import { sources } from '../config/sources.js';
import { createSources } from './sources/index.js';
import { runCheck, CheckInProgressError } from './check.js';
import { getJobs, patchJob, postCheck } from './api.js';
import { notificationApi } from './notification-api.js';
import { deliverNotifications, queueScanAlert, NotificationBusyError } from './notifications.js';
import { importJob } from './import-job.js';
import { preferencesApi } from './preferences.js';
import { reserveWork, cleanCpuBudget, CpuBudgetError } from './cpu-budget.js';
import { readBoundedText, BodyLimitError } from './bounded-body.js';
async function processEmails(env) {
    try {
        await deliverNotifications(env);
    }
    catch (error) {
        if (!(error instanceof NotificationBusyError))
            console.error('Notification processing failed; queued emails will be retried.');
    }
}
export function createWorker(jobSources) {
    return {
        async fetch(request, env) {
            const path = new URL(request.url).pathname;
            if (path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
                if (request.headers.get('Origin') !== new URL(request.url).origin)
                    return Response.json({ error: 'Invalid origin' }, { status: 403 });
                try {
                    await reserveWork(env.DB);
                    const body = await readBoundedText(request, 64 * 1024, 'Request');
                    request = new Request(request, { body });
                } catch (error) {
                    const status = error instanceof BodyLimitError ? 413 : error instanceof CpuBudgetError ? 429 : 503;
                    return Response.json({ error: error instanceof BodyLimitError || error instanceof CpuBudgetError
                        ? error.message : 'CPU safety check unavailable. Changes are paused; try again shortly.' },
                    { status, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(error.retryAfter ?? 60) } });
                }
            }
            if (['/api/coverage', '/api/filtered', '/api/coverage/accept-snapshot', '/api/watchdog'].includes(path)) {
                try {
                    if (path === '/api/watchdog') return await watchdogApi(request, env.DB);
                    return await coverageApi(request, env.DB, jobSources);
                } catch { return Response.json({ error: 'Coverage data is unavailable. Try again shortly.' }, { status: 503 }); }
            }
            if (path === '/api/aggregators') {
                if (request.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
                try { return Response.json(await aggregatorStatus(env), { headers: { 'Cache-Control': 'no-store' } }); }
                catch { return Response.json({ error: 'Aggregator status unavailable' }, { status: 503 }); }
            }
            if (path === '/api/preferences') return preferencesApi(request, env.DB);
            if (path === '/api/jobs/import') {
                if (request.method === 'POST') return importJob(request, env.DB);
                return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
            }
            if (path === '/api/notifications' || path === '/api/notifications/retry' || path === '/api/notifications/test')
                return notificationApi(request, env);
            if (path === '/api/check') {
                if (request.method === 'POST') {
                    const response = await postCheck(request, env.DB, jobSources);
                    if (response.ok)
                        await processEmails(env);
                    return response;
                }
                return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST' } });
            }
            if (path === '/api/jobs') {
                if (request.method === 'GET')
                    return getJobs(request, env.DB, jobSources);
                return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'GET' } });
            }
            const match = /^\/api\/jobs\/([^/]+)$/.exec(path);
            if (match) {
                if (request.method !== 'PATCH')
                    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: 'PATCH' } });
                let id;
                try {
                    id = decodeURIComponent(match[1]);
                }
                catch {
                    return Response.json({ error: 'Invalid job ID' }, { status: 400 });
                }
                return patchJob(request, env.DB, id);
            }
            if (path.startsWith('/api/'))
                return Response.json({ error: 'Not found' }, { status: 404 });
            return env.ASSETS.fetch(request);
        },
        async scheduled(_event, env) {
            // Reserve before entering finally: a denied run must not process mail.
            try { await reserveWork(env.DB); }
            catch (error) {
                console.warn(error instanceof CpuBudgetError ? error.message : 'CPU safety check unavailable; scheduled work paused.');
                return;
            }
            try {
                const minute = new Date(_event.scheduledTime ?? Date.now()).getUTCMinutes();
                if (minute >= jobSources.length * 2) {
                    await cleanCpuBudget(env.DB);
                    await cleanCoverage(env.DB);
                    await pingWatchdog(env.DB, jobSources);
                    await queueScanAlert(env, jobSources);
                    await runAggregators(env);
                    return;
                }
                const report = await runCheck(env.DB, jobSources, { rotate: true, recovery: minute >= jobSources.length });
                console.info('Job check complete', { configuredSources: jobSources.length, report });
            }
            catch (error) {
                if (!(error instanceof CheckInProgressError))
                    throw error;
                console.info('Scheduled check skipped: another check is running.');
            }
            finally {
                await processEmails(env);
            }
        },
    };
}
export default createWorker(createSources(sources));
