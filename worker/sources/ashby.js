import { createFeedReader } from '../bounded-body.js';
import { textKey } from '../../lib/text.js';
import { canonicalizeUrl } from '../../lib/matching.js';

export function ashbySource(config, request = fetch) {
    return {
        id: config.id,
        label: `${config.company} · Ashby`,
        async fetchListings() {
            const readFeedJson = createFeedReader();
            if (typeof config.boardToken !== 'string' || !/^[a-z0-9_.-]+$/i.test(config.boardToken))
                throw new Error('Invalid Ashby board token');
            const response = await request(`https://api.ashbyhq.com/posting-api/job-board/${config.boardToken}`, {
                headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`Ashby returned HTTP ${response.status}`);
            const body = await readFeedJson(response);
            if (!body || !Array.isArray(body.jobs)) throw new Error('Ashby response did not contain a jobs array');
            return body.jobs.flatMap(job => {
                if (!job || typeof job !== 'object' || typeof job.isListed !== 'boolean')
                    throw new Error('Ashby listing is missing its visibility flag');
                // Unlisted postings are intended for direct-link access only.
                if (!job.isListed) return [];
                if (!['title', 'location', 'jobUrl'].every(key => typeof job[key] === 'string' && job[key].trim()) ||
                    (job.secondaryLocations !== undefined && !Array.isArray(job.secondaryLocations)))
                    throw new Error('Ashby listing is missing required fields');
                const locations = [job.location];
                for (const secondary of job.secondaryLocations ?? []) {
                    if (!secondary || typeof secondary.location !== 'string' || !secondary.location.trim())
                        throw new Error('Invalid Ashby secondary location');
                    locations.push(secondary.location);
                }
                const url = canonicalizeUrl(job.jobUrl);
                return [{ sourceJobId: url, title: job.title.trim(), company: config.company,
                    location: [...new Set(locations)].join('; '), url,
                    // publishedAt is the LAST publication, not the original posting date.
                    postedAt: null, description: job.descriptionPlain ?? job.descriptionHtml ?? null,
                    // Some hybrid listings also set isRemote=true; workplaceType is more specific.
                    isRemoteOnly: textKey(job.workplaceType ?? '') === 'remote' || (!job.workplaceType && job.isRemote === true) }];
            });
        },
    };
}
