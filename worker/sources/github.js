import { readBoundedText, FEED_BYTE_LIMIT } from '../bounded-body.js';
import { textKey, plainText as normalizePlainText } from '../../lib/text.js';
import { canonicalizeUrl } from '../../lib/matching.js';

// Repository-specific parsers; not arbitrary GitHub files.
export function parseJsonListings(body, config) {
    if (!Array.isArray(body)) throw new Error('GitHub source did not contain a listings array');
    return body.flatMap(job => {
        if (!job || typeof job !== 'object' || typeof job.active !== 'boolean' || typeof job.is_visible !== 'boolean')
            throw new Error('GitHub listing is missing its active/visible flags');
        if (!job.active || !job.is_visible) return [];
        if (config.format === 'simplify') {
            if (!Array.isArray(job.terms) || typeof job.category !== 'string')
                throw new Error('Simplify listing is missing its term or category');
            if (!job.terms.some(term => typeof term === 'string' && textKey(term) === textKey(config.term)) || !['software', 'software engineering'].includes(textKey(job.category))) return [];
        } else if (config.format === 'simplify-newgrad') {
            if (typeof job.category !== 'string') throw new Error('Simplify listing is missing its category');
            if (!['software', 'software engineering', 'ai/ml/data', 'data science, ai & machine learning'].includes(textKey(job.category))) return [];
        } else if (config.format === 'vansh') {
            // Match the repository's main README, which excludes off-season rows.
            if (!('season' in job)) throw new Error('GitHub listing is missing its season');
            if (typeof job.season !== 'string' || textKey(job.season) !== 'summer') return [];
        } else throw new Error('Unsupported GitHub JSON format');
        if (!['id', 'title', 'company_name', 'url'].every(key => typeof job[key] === 'string' && job[key].trim()) ||
            !Array.isArray(job.locations) || !job.locations.length || !job.locations.every(location => typeof location === 'string' && location.trim()))
            throw new Error('GitHub listing is missing required fields');
        return [{ sourceJobId: job.id, title: job.title, company: job.company_name,
            location: job.locations.join('; '), url: canonicalizeUrl(job.url),
            // Repository timestamps describe the repository, not employer posting dates.
            postedAt: null }];
    });
}

function decodeEntities(text) {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
    return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
        if (!code.startsWith('#')) return named[code.toLowerCase()];
        const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
    });
}
function plainText(text) {
    return normalizePlainText(text.replace(/<br\s*\/?\s*>/gi, '; ').replace(/<[^>]*>/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/\\\|/g, '|')).trim();
}

export function parseSpeedyTable(markdown) {
    const listings = [];
    let foundHeader = false;
    let inTable = false;
    let company = '';
    let columnCount = 0;
    let postingIndex = 0;
    for (const line of markdown.split(/\r?\n/)) {
        if (!line.trim().startsWith('|')) { inTable = false; continue; }
        const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(cell => cell.trim());
        if (textKey(cells[0]) === 'company' && textKey(cells[1]) === 'position') {
            if (!['company|position|location|salary|posting|age', 'company|position|location|posting|age'].includes(cells.map(textKey).join('|')))
                throw new Error('SpeedyApply table columns changed');
            foundHeader = inTable = true;
            company = '';
            columnCount = cells.length;
            postingIndex = cells.map(textKey).indexOf('posting');
            continue;
        }
        if (!inTable || cells.every(cell => /^:?-+:?$/.test(cell))) continue;
        if (cells.length !== columnCount) throw new Error('SpeedyApply table columns changed');
        const currentCompany = plainText(cells[0]);
        if (!['↳', '↪', ''].includes(currentCompany)) company = currentCompany;
        if (/🔒|\bclosed\b/i.test(plainText(cells[postingIndex]))) continue;
        const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(cells[postingIndex])?.[1]
            ?? /\[[^\]]*\]\(([^)]+)\)/.exec(cells[postingIndex])?.[1];
        const title = plainText(cells[1]);
        const location = plainText(cells[2]);
        if (!company || !title || !location || !href) throw new Error('SpeedyApply row is missing required fields');
        const url = canonicalizeUrl(decodeEntities(href));
        listings.push({ sourceJobId: url, title, company, location, url, postedAt: null });
    }
    if (!foundHeader) throw new Error('SpeedyApply job table was not found; the repository format may have changed');
    return listings;
}

export function githubSource(config, request = fetch) {
    return {
        id: config.id,
        label: `${config.owner}/${config.repo} · GitHub`,
        async fetchListings() {
            if (![config.owner, config.repo, config.branch].every(value => typeof value === 'string' && /^[a-z0-9_.-]+$/i.test(value)))
                throw new Error('Invalid GitHub repository configuration');
            if (!['simplify', 'simplify-newgrad', 'vansh', 'speedy'].includes(config.format)) throw new Error('Unsupported GitHub source format');
            const file = config.format === 'speedy' ? 'README.md' : '.github/scripts/listings.json';
            const response = await request(`https://raw.githubusercontent.com/${config.owner}/${config.repo}/${config.branch}/${file}`, {
                headers: { Accept: 'text/plain' }, signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`GitHub source returned HTTP ${response.status}`);
            const content = await readBoundedText(response, FEED_BYTE_LIMIT, 'GitHub source');
            return config.format === 'speedy' ? parseSpeedyTable(content) : parseJsonListings(JSON.parse(content), config);
        },
    };
}
