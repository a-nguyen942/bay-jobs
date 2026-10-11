// Keep the existing array-returning adapters usable by tests and local tools.
// Only the monitor supplies a validator from a successfully committed import.
class NotModified extends Error {}
export function conditionalSource(factory, config, request) {
    const source = factory(config, request);
    return { ...source, cacheKey: JSON.stringify(config),
        async fetchListings({ etag, onResponse } = {}) {
            let firstRequest = true;
            const adapter = factory(config, async (url, options) => {
                const isIndex = firstRequest;
                firstRequest = false;
                const headers = new Headers(options.headers);
                if (isIndex && etag) headers.set('If-None-Match', etag);
                const response = await request(url, { ...options, headers });
                if (response.status === 304) {
                    if (!isIndex || !etag) throw new Error('Source returned 304 without a saved validator');
                    throw new NotModified();
                }
                if (isIndex) onResponse?.(response.headers.get('ETag'));
                return response;
            });
            try { return await adapter.fetchListings(); }
            catch (error) { if (error instanceof NotModified) return null; throw error; }
        },
    };
}
