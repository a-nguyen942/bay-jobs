import { parseLinkedinIndex } from './sources/linkedin-index.js';
import { runCheck } from './check.js';
import { readBoundedText } from './bounded-body.js';
import { canonicalizeUrl } from '../lib/matching.js';

// One first-page request per provider per 26 hours, including failed attempts.
// At most 29 requests in any 31-day interval from this database.
export const AGGREGATOR_INTERVAL = 26 * 60 * 60 * 1000;
const definitions = [
    { id: 'adzuna', label: 'Adzuna · daily discovery', keys: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'] },
    { id: 'linkedin-index', label: 'LinkedIn via search index · daily discovery', keys: ['SERPAPI_API_KEY'] },
    { id: 'google-jobs', label: 'Google Jobs via SerpApi · daily discovery', keys: ['SERPAPI_API_KEY'] },
];
const enabled = (definition, env) => env.FREE_AGGREGATOR_IMPORTS === 'true' && definition.keys.every(key => typeof env[key] === 'string' && env[key].trim());
function required(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Aggregator listing is missing required fields');
    return value;
}
export function parseAggregator(id, body) {
    if (id === 'linkedin-index') return parseLinkedinIndex(body);
    const rows = id === 'adzuna' ? body?.results : body?.jobs_results;
    if (!Array.isArray(rows)) throw new Error('Aggregator response format changed or returned an error');
    return rows.map(row => {
        const url = id === 'adzuna' ? row.redirect_url : row.apply_options?.find(option => typeof option.link === 'string')?.link;
        return {
            sourceJobId: String(row.id ?? row.job_id ?? required(url)),
            title: required(row.title), company: required(id === 'adzuna' ? row.company?.display_name : row.company_name),
            location: required(id === 'adzuna' ? row.location?.display_name : row.location),
            url: canonicalizeUrl(required(url)), description: typeof row.description === 'string' ? row.description : '',
            postedAt: null,
        };
    });
}
export function aggregatorSources(env, request = fetch, clock = Date.now) {
    return definitions.filter(definition => enabled(definition, env)).map(definition => ({
        id: definition.id, label: definition.label, discoveryOnly: true,
        async fetchListings() {
            const now = clock();
            const reservation = await env.DB.prepare(`INSERT INTO aggregator_budget(provider, next_allowed_at) VALUES (?, ?)
                ON CONFLICT(provider) DO UPDATE SET next_allowed_at = excluded.next_allowed_at
                WHERE aggregator_budget.next_allowed_at <= ? RETURNING provider`)
                .bind(definition.id, now + AGGREGATOR_INTERVAL, now).first();
            if (!reservation) throw new Error('Aggregator request limit reached; waiting for next daily discovery');
            let url;
            if (definition.id === 'adzuna') {
                url = new URL('https://api.adzuna.com/v1/api/jobs/us/search/1');
                url.search = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY,
                    what: 'software', where: 'San Francisco, CA', distance: '100', results_per_page: '50', sort_by: 'date' });
            } else if (definition.id === 'linkedin-index') {
                url = new URL('https://serpapi.com/search.json');
                url.search = new URLSearchParams({ engine: 'google', api_key: env.SERPAPI_API_KEY,
                    q: 'site:linkedin.com/jobs/view ("software" OR "data") (intern OR "new grad") ("San Francisco" OR "San Jose" OR "Bay Area")',
                    tbs: 'qdr:w', hl: 'en', gl: 'us' });
            } else {
                url = new URL('https://serpapi.com/search.json');
                url.search = new URLSearchParams({ engine: 'google_jobs', api_key: env.SERPAPI_API_KEY,
                    q: 'software engineer internship OR new grad', location: 'San Francisco Bay Area, California, United States', hl: 'en', gl: 'us' });
            }
            // Never surface provider bodies or exception messages containing keyed URLs.
            let response;
            try { response = await request(url.toString(), { signal: AbortSignal.timeout(15_000), redirect: 'manual', headers: { Accept: 'application/json' } }); }
            catch { throw new Error('Aggregator request failed; next attempt is limited to the daily schedule'); }
            if (!response.ok) throw new Error(`Aggregator returned HTTP ${response.status}; check the provider account`);
            let body;
            try { body = JSON.parse(await readBoundedText(response, 2 * 1024 * 1024, 'Aggregator')); }
            catch { throw new Error('Aggregator response was invalid or exceeded the size limit'); }
            return parseAggregator(definition.id, body);
        },
    }));
}
export async function runAggregators(env, request = fetch, clock = Date.now) {
    for (const source of aggregatorSources(env, request, clock)) {
        const budget = await env.DB.prepare('SELECT next_allowed_at FROM aggregator_budget WHERE provider = ?').bind(source.id).first();
        if (budget && budget.next_allowed_at > clock()) continue;
        // Shares the monitor lease with manual and employer-source checks.
        await runCheck(env.DB, [source]);
    }
}
export async function aggregatorStatus(env) {
    const rows = [];
    for (const definition of definitions) {
        const run = await env.DB.prepare('SELECT last_success_at, error, matched_count FROM source_runs WHERE source_id = ?').bind(definition.id).first();
        const budget = await env.DB.prepare('SELECT next_allowed_at FROM aggregator_budget WHERE provider = ?').bind(definition.id).first();
        rows.push({ id: definition.id, label: definition.label, enabled: enabled(definition, env),
            lastSuccessAt: run?.last_success_at ?? null, error: run?.error ?? null,
            matchedCount: run?.matched_count ?? 0, nextAttemptAt: budget ? new Date(budget.next_allowed_at).toISOString() : null });
    }
    return rows;
}
