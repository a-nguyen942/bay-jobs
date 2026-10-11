import { textKey } from './text.js';
export function canonicalizeUrl(raw) {
    if (typeof raw !== 'string' || /[\u0000-\u0020\u007f\u200b\u2060]/u.test(raw.trim())) throw new Error('Invalid application URL');
    const url = new URL(raw.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid application URL');
    const greenhouse = ['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname);
    // Unknown sites may encode the entire job ID in the fragment (#/jobs/123).
    // Only known Greenhouse job pages have safe-to-discard section anchors.
    const greenhouseJob = greenhouse && /^\/[^/]+\/jobs\/\d+\/?$/.test(url.pathname);
    if (greenhouseJob)
        url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(key) || (greenhouse && key === 'gh_src'))
            url.searchParams.delete(key);
    }
    // Only remove a redundant ID when it agrees with the ID in the path.
    if (greenhouseJob && url.searchParams.getAll('gh_jid').every(id => id === url.pathname.split('/').filter(Boolean).at(-1)))
        url.searchParams.delete('gh_jid');
    // The old and new Greenhouse board domains identify the same postings.
    if (url.hostname === 'boards.greenhouse.io')
        url.hostname = 'job-boards.greenhouse.io';
    if (greenhouseJob)
        url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
}
export function experienceLevel(job) {
    if (job.isIntern || /\b(intern(?:ships?)?|co[ -]?op)\b/i.test(textKey(job.title))) return 'internship';
    if (/\b(new[ -]?grad(?:uate)?|entry[ -]?level|junior|university graduate|graduate engineer)\b|\bengineer (?:I|1)\b/i.test(textKey(job.title))) return 'new_grad';
    if (/\b(senior|sr\.?|staff|principal|lead|manager|director|mid[ -]?level)\b|\bengineer (?:II|III|IV|[2-9])\b/i.test(textKey(job.title))) return 'experienced';
    return 'unspecified';
}
export function matchesSearch(job, preferences) {
    return createMatcher(preferences)(job);
}
export function createMatcher(preferences) {
    const reason = rejectionReason(preferences);
    return job => reason(job) === null;
}
export function broadLocation(job) {
    const location = textKey(job.location);
    return !location || /^(?:unspecified|unknown|not specified|multiple locations|united states(?: of america)?|usa|us|u\.s\.?|north america)$/i.test(location)
        || job.isRemoteOnly === true || /\bremote\b/i.test(location);
}
export function rejectionReason(preferences) {
    const normalize = textKey;
    const copyPattern = pattern => new RegExp(pattern.source, [...new Set(pattern.flags.replace(/[gy]/g, '') + 'i')].join(''));
    const rolePattern = copyPattern(preferences.rolePattern);
    const excludedRolePattern = preferences.excludedRolePattern && copyPattern(preferences.excludedRolePattern);
    const levels = preferences.experienceLevels?.map(textKey);
    const keywords = preferences.keywords?.map(textKey);
    const excludedKeywords = preferences.excludedKeywords?.map(textKey);
    const cityPatterns = preferences.locations.map(city => {
        const escaped = normalize(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}[\\s,()–-]+(?:california|ca)\\b`);
    });
    return job => {
        if (levels && !levels.includes(experienceLevel(job))) return 'Experience level excluded';
        const title = textKey(job.title);
        if (keywords?.length && !keywords.some(word => title.includes(word))) return 'Required title keyword missing';
        if (excludedKeywords?.some(word => title.includes(word))) return 'Excluded title keyword';
        if (job.isRemoteOnly && !preferences.includeRemote) return 'Remote roles excluded';
        if (!rolePattern.test(title) || (excludedRolePattern && excludedRolePattern.test(textKey(job.title)))) return 'Outside configured role keywords';
        const locations = normalize(job.location).split(/\s*(?:[;•|/\n]|\bor\b)\s*/);
        const inBayArea = locations.some(location => {
            // Explicit foreign country qualifiers must not be interpreted as California.
            if (/\b(canada|costa rica|mexico|united kingdom|australia|india)\b/.test(location))
                return false;
            return cityPatterns.some(pattern => pattern.test(location));
        });
        return inBayArea || (preferences.includeRemote && (job.isRemoteOnly || /\bremote\b/i.test(normalize(job.location)))) ? null
            : broadLocation(job) ? 'Location needs review' : 'Outside selected locations';
    };
}
