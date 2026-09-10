export function canonicalizeUrl(raw) {
    const url = new URL(raw);
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
export function matchesSearch(job, preferences) {
    // Strip stateful flags so reusing a caller's regex cannot alternate matches.
    const test = (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, '')).test(job.title);
    if (!test(preferences.rolePattern) || (preferences.excludedRolePattern && test(preferences.excludedRolePattern)))
        return false;
    const normalize = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const locations = normalize(job.location).split(/\s*(?:[;•|/\n]|\bor\b)\s*/);
    const inBayArea = locations.some(location => {
        // Explicit foreign country qualifiers must not be interpreted as California.
        if (/\b(canada|costa rica|mexico|united kingdom|australia|india)\b/.test(location))
            return false;
        return preferences.locations.some(city => {
            const escaped = normalize(city).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Require the state next to this city, not elsewhere in a multi-location label.
            return new RegExp(`\\b${escaped}[\\s,()–-]+(?:california|ca)\\b`).test(location);
        });
    });
    return inBayArea || (preferences.includeRemote && /\bremote\b/i.test(job.location));
}
