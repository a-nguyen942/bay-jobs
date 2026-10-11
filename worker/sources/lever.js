import { createFeedReader } from '../bounded-body.js';
import { textKey } from '../../lib/text.js';
import { canonicalizeUrl } from '../../lib/matching.js';

export function leverSource(config, request = fetch) {
    return {
        id: config.id,
        label: `${config.company} · Lever`,
        async fetchListings() {
            const readFeedJson = createFeedReader();
            if (typeof config.boardToken !== 'string' || !/^[a-z0-9_-]+$/i.test(config.boardToken))
                throw new Error('Invalid Lever board token');
            if (config.region !== undefined && !['global', 'eu'].includes(config.region))
                throw new Error('Invalid Lever region');
            const host = config.region === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
            const pageSize = 100;
            const listings = [];
            const ids = new Set();
            // One deadline for the complete feed, including all pages and response bodies.
            const signal = AbortSignal.timeout(15_000);
            for (let page = 0; page < 20; page++) {
                const response = await request(`https://${host}/v0/postings/${config.boardToken}?mode=json&limit=${pageSize}&skip=${page * pageSize}`, {
                    headers: { Accept: 'application/json' }, signal,
                });
                if (!response.ok) throw new Error(`Lever returned HTTP ${response.status}`);
                const jobs = await readFeedJson(response);
                if (!Array.isArray(jobs) || jobs.length > pageSize) throw new Error('Invalid Lever postings page');
                for (const job of jobs) {
                    if (!job || !['id', 'text', 'hostedUrl'].every(key => typeof job[key] === 'string' && job[key].trim()) ||
                        typeof job.categories?.location !== 'string' || !job.categories.location.trim() ||
                        (job.categories.allLocations !== undefined && !Array.isArray(job.categories.allLocations)))
                        throw new Error('Lever listing is missing required fields');
                    if (ids.has(job.id)) throw new Error('Lever repeated a posting while paginating; retry the source check');
                    ids.add(job.id);
                    const locations = [job.categories.location, ...(job.categories.allLocations ?? [])];
                    if (!locations.every(location => typeof location === 'string' && location.trim()))
                        throw new Error('Invalid Lever location');
                    listings.push({ sourceJobId: job.id, title: job.text.trim(), company: config.company,
                        location: [...new Set(locations)].join('; '), url: canonicalizeUrl(job.hostedUrl),
                        // Creation time does not establish when an employer published a posting.
                        postedAt: null, description: [job.descriptionPlain ?? job.description ?? '', ...(job.lists ?? []).map(item => `${item.text ?? ''} ${item.content ?? ''}`), job.additionalPlain ?? job.additional ?? ''].join(' '), isRemoteOnly: textKey(job.workplaceType ?? '') === 'remote' });
                }
                if (jobs.length < pageSize) return listings;
            }
            // Do not return a partial feed or establish a misleading notification baseline.
            throw new Error('Lever exceeded the 20-page limit; narrow the source before retrying');
        },
    };
}
