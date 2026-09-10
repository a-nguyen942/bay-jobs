export function greenhouseSource(config, request = fetch) {
    return {
        id: config.id,
        label: `${config.company} · Greenhouse`,
        async fetchListings() {
            if (!/^[a-z0-9_-]+$/i.test(config.boardToken))
                throw new Error('Invalid Greenhouse board token');
            const response = await request(`https://boards-api.greenhouse.io/v1/boards/${config.boardToken}/jobs`, {
                headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok)
                throw new Error(`Greenhouse returned HTTP ${response.status}`);
            const body = await response.json();
            if (!body || !Array.isArray(body.jobs))
                throw new Error('Greenhouse response did not contain a jobs array');
            return body.jobs.map((raw) => {
                if (!raw || typeof raw !== 'object')
                    throw new Error('Invalid Greenhouse listing');
                const job = raw;
                const location = job.location;
                if ((typeof job.id !== 'number' && typeof job.id !== 'string') || typeof job.title !== 'string' || typeof job.absolute_url !== 'string' || typeof location?.name !== 'string') {
                    throw new Error('Greenhouse listing is missing required fields');
                }
                return {
                    sourceJobId: String(job.id), title: job.title, company: config.company,
                    location: location.name, url: job.absolute_url,
                    // updated_at is NOT a posting date. Keep this unknown unless the source supplies one.
                    postedAt: null,
                };
            });
        },
    };
}
