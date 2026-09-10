import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sendEmail } from '../worker/notifications.js';
const payload = { from: 'alerts@example.com', to: ['me@example.com'], subject: 'Bay Jobs: 1 new match', text: 'Example role' };
test('Resend transport sends an immutable body with a stable idempotency key', async (context) => {
    context.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(url, 'https://api.resend.com/emails');
        assert.equal(init.method, 'POST');
        const headers = new Headers(init.headers);
        assert.equal(headers.get('Authorization'), 'Bearer test-only-key');
        assert.equal(headers.get('Idempotency-Key'), 'bay-jobs/message-123');
        assert.deepEqual(JSON.parse(init.body), payload);
        assert.ok(init.signal);
        return Response.json({ id: 'receipt-123' });
    });
    assert.equal(await sendEmail(payload, 'message-123', 'test-only-key'), 'receipt-123');
});
test('provider rate limits retry while invalid credentials fail without exposing the response body', async (context) => {
    let status = 429;
    context.mock.method(globalThis, 'fetch', async () => new Response('sensitive provider details', { status }));
    await assert.rejects(sendEmail(payload, 'message-123', 'test-only-key'), error => {
        assert.ok(error instanceof Error && 'retryable' in error);
        assert.equal(error.retryable, true);
        assert.doesNotMatch(error.message, /sensitive/);
        return true;
    });
    status = 401;
    await assert.rejects(sendEmail(payload, 'message-123', 'test-only-key'), error => {
        assert.ok(error instanceof Error && 'retryable' in error);
        assert.equal(error.retryable, false);
        return true;
    });
});
