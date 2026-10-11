export class BodyLimitError extends Error {}
// Count decoded stream bytes; Content-Length alone may be absent or compressed.
export async function readBoundedText(message, limit, label = 'Response', onBytes = () => {}) {
    if (Number(message.headers.get('Content-Length')) > limit) {
        await message.body?.cancel();
        throw new BodyLimitError(`${label} exceeds the ${limit}-byte safety limit`);
    }
    if (!message.body) return '';
    const reader = message.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new BodyLimitError(`${label} exceeds the ${limit}-byte safety limit`);
            }
            onBytes(value.byteLength);
            chunks.push(value);
        }
    } catch (error) {
        try { await reader.cancel(); } catch { /* Keep the original read failure. */ }
        throw error;
    } finally { reader.releaseLock(); }
    return new Blob(chunks).text();
}
export const FEED_BYTE_LIMIT = 20 * 1024 * 1024;
export function createFeedReader() {
    let remaining = FEED_BYTE_LIMIT;
    return async response => JSON.parse(await readBoundedText(response, remaining, 'Source feed', bytes => {
        remaining -= bytes;
        if (remaining < 0) throw new BodyLimitError('Source feed exceeds the 20 MiB total safety limit');
    }));
}
