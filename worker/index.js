import { sources } from '../config/sources.js';
import { greenhouseSource } from './sources/greenhouse.js';
import { runCheck, CheckInProgressError } from './check.js';
import { getJobs, patchJob, postCheck } from './api.js';
import { notificationApi } from './notification-api.js';
import { deliverNotifications, NotificationBusyError } from './notifications.js';
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
            if (path === '/api/notifications' || path === '/api/notifications/retry')
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
                    return getJobs(request, env.DB);
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
            try {
                const report = await runCheck(env.DB, jobSources);
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
export default createWorker(sources.map(source => greenhouseSource(source)));
