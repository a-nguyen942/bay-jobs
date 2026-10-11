import { createFeedReader } from '../bounded-body.js';
import { plainText, textKey } from '../../lib/text.js';
import { searchPreferences } from '../../config/search.js';
function internship(title) {
    title = textKey(plainText(title));
    return /\b(?:intern|internship|internships|co[ -]?op)\b/i.test(title)
        && searchPreferences.rolePattern.test(title) && !searchPreferences.excludedRolePattern.test(title);
}
export function greenhouseSource(config, request = fetch) {
    function normalize(job) {
        if (!job || typeof job !== 'object') throw new Error('Invalid Greenhouse listing');
        if ((typeof job.id !== 'number' && typeof job.id !== 'string') || typeof job.title !== 'string'
            || typeof job.absolute_url !== 'string' || typeof job.location?.name !== 'string')
            throw new Error('Greenhouse listing is missing required fields');
        return { sourceJobId: String(job.id), title: job.title, company: config.company,
            location: job.location.name, url: job.absolute_url,
            // updated_at is not the original employer posting date.
            postedAt: null, description: typeof job.content === 'string' ? job.content : null };
    }
    return {
        id: config.id,
        label: `${config.company} · Greenhouse`,
        async fetchListings() {
            const readFeedJson = createFeedReader();
            if (!/^[a-z0-9_-]+$/i.test(config.boardToken)) throw new Error('Invalid Greenhouse board token');
            const base = `https://boards-api.greenhouse.io/v1/boards/${config.boardToken}/jobs`;
            // One deadline for the index, descriptions and response bodies.
            const signal = AbortSignal.timeout(15_000);
            const read = async url => {
                const response = await request(url, { headers: { Accept: 'application/json' }, signal });
                if (!response.ok) throw new Error(`Greenhouse returned HTTP ${response.status}`);
                return readFeedJson(response);
            };
            const body = await read(config.internshipsOnly ? base : `${base}?content=true`);
            if (!body || !Array.isArray(body.jobs)) throw new Error('Greenhouse response did not contain a jobs array');
            if (body.meta?.total !== undefined && (!Number.isInteger(body.meta.total) || body.meta.total !== body.jobs.length))
                throw new Error('Greenhouse returned an incomplete jobs index');
            const listings = body.jobs.map(normalize);
            if (!config.internshipsOnly) return listings;
            // Avoid parsing every full-time description on large employer boards.
            // Validate the full index, then request only technical internship details.
            const selected = listings.filter(job => internship(job.title));
            if (selected.length > 12) throw new Error('Greenhouse internship feed exceeds the 12-description limit; review source scope');
            const detailed = [];
            for (let offset = 0; offset < selected.length; offset += 2) {
                const chunk = await Promise.all(selected.slice(offset, offset + 2).map(async job => {
                    const raw = await read(`${base}/${encodeURIComponent(job.sourceJobId)}`);
                    const full = normalize(raw);
                    if (full.sourceJobId !== job.sourceJobId || full.description === null)
                        throw new Error('Greenhouse internship detail is incomplete or has the wrong job ID');
                    return full;
                }));
                detailed.push(...chunk);
            }
            // An index/detail failure rejects the entire snapshot, never a partial feed.
            return detailed.filter(job => internship(job.title));
        },
    };
}
