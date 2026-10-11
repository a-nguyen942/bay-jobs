import { tokenKey, emailAddress } from '../lib/text.js';
import { ALL_SKILLS } from '../lib/skills.js';
import { deliverNotifications, notificationState, saveSettings, retryNotifications, queueTestEmail, validEmail, NotificationBusyError } from './notifications.js';
export async function notificationApi(request, env) {
    const retry = new URL(request.url).pathname === '/api/notifications/retry';
    const test = new URL(request.url).pathname === '/api/notifications/test';
    const allowed = retry || test ? ['POST'] : ['GET', 'PATCH'];
    if (!allowed.includes(request.method))
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowed.join(', ') } });
    if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    try {
        if (test) {
            await queueTestEmail(env);
            await deliverNotifications(env);
        }
        else if (retry) {
            await retryNotifications(env);
            await deliverNotifications(env);
        }
        else if (request.method === 'PATCH') {
            let body;
            try {
                body = await request.json();
            }
            catch {
                return Response.json({ error: 'Invalid JSON' }, { status: 400 });
            }
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return Response.json({ error: 'Invalid notification settings' }, { status: 400 });
            const patch = { ...body };
            patch.recipient = emailAddress(patch.recipient);
            patch.cadence = tokenKey(patch.cadence);
            if ('skillMode' in patch) patch.skillMode = tokenKey(patch.skillMode);
            if (Object.keys(patch).some(key => !['enabled', 'recipient', 'cadence', 'skillFilter', 'skillMask', 'skillMode', 'internshipsOnly', 'scanAlerts'].includes(key)) ||
                ('scanAlerts' in patch && typeof patch.scanAlerts !== 'boolean') ||
                ('skillFilter' in patch && typeof patch.skillFilter !== 'boolean') ||
                ('internshipsOnly' in patch && typeof patch.internshipsOnly !== 'boolean') ||
                ('skillMask' in patch && (!Number.isInteger(patch.skillMask) || patch.skillMask < 1 || patch.skillMask > ALL_SKILLS)) ||
                ('skillMode' in patch && !['any', 'all'].includes(patch.skillMode)) ||
                typeof patch.enabled !== 'boolean' || typeof patch.recipient !== 'string' ||
                !['each_check', 'daily'].includes(patch.cadence) ||
                (patch.recipient !== '' && !validEmail(patch.recipient)) || (patch.enabled && !patch.recipient)) {
                return Response.json({ error: 'Enter a valid email address and notification schedule.' }, { status: 400 });
            }
            await saveSettings(env, patch);
        }
        return Response.json(await notificationState(env), { headers: { 'Cache-Control': 'no-store' } });
    }
    catch (error) {
        if (error instanceof NotificationBusyError)
            return Response.json({ error: error.message }, { status: 409 });
        // Only expose expected setup errors; database/transport internals stay on the server.
        const message = error instanceof Error && /^(Configure RESEND|Enable and configure)/.test(error.message) ? error.message : 'Notification service unavailable. Check setup and try again.';
        return Response.json({ error: message }, { status: 503 });
    }
}
