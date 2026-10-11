import { cleanText } from '../../lib/text.js';
import { canonicalizeUrl } from '../../lib/matching.js';

export function linkedinJobUrl(raw) {
    const url = new URL(canonicalizeUrl(raw));
    const match = /^\/jobs\/view\/(?:[^/]*-)?(\d+)\/?$/.exec(url.pathname);
    if (!(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) || !match)
        throw new Error('Search result is not a LinkedIn job listing');
    return `https://www.linkedin.com/jobs/view/${match[1]}`;
}
// Public search titles expose role/company/location in these two known forms.
// Never infer a job's location from the search query or invent missing fields.
export function parseLinkedinIndex(body) {
    if (!Array.isArray(body?.organic_results)) throw new Error('LinkedIn indexed search returned an invalid response');
    const listings = [];
    let candidates = 0;
    for (const row of body.organic_results) {
        let url;
        try { url = linkedinJobUrl(row.link); } catch { continue; }
        candidates++;
        if (typeof row.title !== 'string') continue;
        const title = cleanText(row.title).replace(/\s*\|\s*LinkedIn(?: Jobs)?\s*$/i, '');
        const hiring = /^(.+?) hiring (.+) in (.+)$/i.exec(title);
        const at = /^(.+) at (.+?) [—–] (.+)$/.exec(title);
        const fields = hiring ? { company: hiring[1], title: hiring[2], location: hiring[3] }
            : at ? { title: at[1], company: at[2], location: at[3] } : null;
        if (!fields || Object.values(fields).some(value => /(?:…|\.\.\.)/.test(value) || !value.trim())) continue;
        listings.push({ ...fields, url, sourceJobId: url.split('/').at(-1), postedAt: null,
            description: typeof row.snippet === 'string' ? row.snippet : '' });
    }
    if (candidates && !listings.length) throw new Error('LinkedIn results were found, but their titles lacked complete role/company/location data');
    return listings;
}
