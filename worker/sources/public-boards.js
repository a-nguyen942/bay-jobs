import { decodeHTML } from 'entities';
import { readBoundedText } from '../bounded-body.js';
import { canonicalizeUrl } from '../../lib/matching.js';

function text(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Public board listing is missing required text');
    return value;
}
function jsonScript(html) {
    const raw = /<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script\s*>/i.exec(html)?.[1];
    if (!raw) throw new Error('Wellfound public listing data was not found; the page may have changed');
    return JSON.parse(raw);
}
export function parseWellfound(html, city) {
    const props = jsonScript(html)?.props?.pageProps;
    if (props?.location !== city || props?.role !== 'software-engineer') throw new Error('Wellfound returned a different search page');
    const data = props?.apolloState?.data;
    const talent = data?.ROOT_QUERY?.talent;
    const key = `seoLandingPageJobSearchResults(${JSON.stringify({ location: city, page: 1, role: 'software-engineer' })})`;
    const results = talent?.[key];
    if (!Array.isArray(results?.startups) || !Number.isInteger(results.totalJobCount)) throw new Error('Wellfound public search format changed');
    const listings = [];
    for (const reference of results.startups) {
        const company = data[reference?.__ref];
        if (!company || !Array.isArray(company.highlightedJobListings)) throw new Error('Wellfound company data is incomplete');
        for (const reference of company.highlightedJobListings) {
            const job = data[reference?.__ref];
            if (!job || !Array.isArray(job.locationNames) || !job.locationNames.every(location => typeof location === 'string')) throw new Error('Wellfound job data is incomplete');
            if (!/^\d+$/.test(String(job.id)) || !/^[a-z0-9-]+$/i.test(job.slug)) throw new Error('Wellfound job identity changed');
            // Only qualify the exact city selected by this CA search page. Keep
            // other ambiguous names unchanged for the conservative shared matcher.
            const selectedCity = city === 'san-francisco' ? 'San Francisco' : 'San Jose';
            const locations = job.locationNames.map(location => location === selectedCity ? `${location}, CA` : location);
            if (job.remote === true) locations.push('Remote');
            listings.push({ sourceJobId: String(job.id), title: text(job.title), company: text(company.name),
                location: locations.join('; '), url: `https://wellfound.com/jobs/${job.id}-${job.slug}`,
                description: typeof job.description === 'string' ? job.description : '',
                isRemoteOnly: job.remoteConfig?.kind === 'REMOTE', isIntern: job.jobType === 'internship', postedAt: null });
        }
    }
    if (results.totalJobCount > 0 && !listings.length) throw new Error('Wellfound search claims jobs but supplied no listings');
    return listings;
}
export function parseYC(html) {
    const raw = /\bdata-page="([^"]+)"/i.exec(html)?.[1];
    if (!raw) throw new Error('YC public listing data was not found; the page may have changed');
    const rows = JSON.parse(decodeHTML(raw))?.props?.jobPostings;
    if (!Array.isArray(rows)) throw new Error('YC public search format changed');
    return rows.map(job => {
        const url = new URL(text(job.url), 'https://www.ycombinator.com');
        if (url.origin !== 'https://www.ycombinator.com' || !/^\/companies\/[^/]+\/jobs\/[^/]+$/.test(url.pathname)) throw new Error('YC returned an invalid job link');
        return { sourceJobId: String(job.id), title: text(job.title), company: text(job.companyName),
            location: text(job.location), url: canonicalizeUrl(url.toString()), isIntern: job.type === 'Internship', postedAt: null };
    });
}
export function publicBoardSource(config, request = fetch) {
    const yc = config.kind === 'yc';
    if (!yc && !['san-francisco', 'san-jose'].includes(config.city)) throw new Error('Unsupported public board city');
    const url = yc ? 'https://www.ycombinator.com/jobs/role/software-engineer/san-francisco'
        : `https://wellfound.com/role/l/software-engineer/${config.city}`;
    return { id: config.id, label: yc ? 'YC · public SF engineering listings' : `Wellfound · ${config.city === 'san-francisco' ? 'SF' : 'San Jose'} public listings`,
        discoveryOnly: true,
        async fetchListings() {
            const response = await request(url, { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
            if (!response.ok) throw new Error(`Public board returned HTTP ${response.status}; no listings were imported`);
            const html = await readBoundedText(response, 2 * 1024 * 1024, 'Public board');
            return yc ? parseYC(html) : parseWellfound(html, config.city);
        },
    };
}
