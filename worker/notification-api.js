import { deliverNotifications, notificationState, saveSettings, retryNotifications, validEmail, NotificationBusyError } from './notifications.js';
export async function notificationApi(request, env) {
    const retry = new URL(request.url).pathname === '/api/notifications/retry';
    const allowed = retry ? ['POST'] : ['GET', 'PATCH'];
    if (!allowed.includes(request.method))
        return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { Allow: allowed.join(', ') } });
    if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin)
        return Response.json({ error: 'Invalid origin' }, { status: 403 });
    try {
        if (retry) {
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
            const patch = body;
            if (Object.keys(patch).length !== 3 || Object.keys(patch).some(key => !['enabled', 'recipient', 'cadence'].includes(key)) ||
                typeof patch.enabled !== 'boolean' || typeof patch.recipient !== 'string' ||
                !['each_check', 'daily'].includes(patch.cadence) ||
                (patch.recipient !== '' && !validEmail(patch.recipient)) || (patch.enabled && !patch.recipient)) {
                return Response.json({ error: 'Enter a valid email address and notification schedule.' }, { status: 400 });
            }
            await saveSettings(env, { enabled: patch.enabled, recipient: patch.recipient, cadence: patch.cadence });
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
