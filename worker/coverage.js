import { listingText, textKey, searchKey, tokenKey } from '../lib/text.js';
import { canonicalizeUrl, experienceLevel, rejectionReason, broadLocation } from '../lib/matching.js';
import { skillMask } from '../lib/skills.js';
import { JOB_COLUMNS, toJob } from '../db/jobs.js';
const DAY = 86400000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export const pacificDay = now => dateFormatter.format(new Date(now));
export function dayBounds(day) {
    // Offset at midnight, independently for each boundary (23/25-hour DST days).
    const midnight = date => {
        const utc = Date.parse(`${date}T00:00:00Z`);
        const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'shortOffset', hour: 'numeric' })
            .formatToParts(new Date(utc + 7 * 3600000)).find(part => part.type === 'timeZoneName').value;
        return new Date(utc - Number(offset.replace('GMT', '')) * 3600000).toISOString();
    };
    return [midnight(day), midnight(new Date(Date.parse(`${day}T12:00:00Z`) + DAY).toISOString().slice(0, 10))];
}
export async function assertFeedIntegrity(db, source, feed) {
    if (!Array.isArray(feed)) throw new Error('Source response is not a complete listings array');
    for (const job of feed) {
        if (!job || !['title', 'company', 'location', 'url'].every(key => typeof job[key] === 'string') || !job.title.trim() || !job.company.trim())
            throw new Error('Source listing format changed or required fields are missing');
        canonicalizeUrl(job.url);
    }
    const count = new Set(feed.map(job => canonicalizeUrl(job.url))).size;
    const scope = source.cacheKey ?? source.id;
    // Ranked search pages are samples, not complete board snapshots.
    if (source.discoveryOnly) return { count, scope };
    let previous = await db.prepare('SELECT * FROM source_integrity WHERE source_id = ?').bind(source.id).first();
    // Existing installations can protect the very first new check using their committed feed.
    if (!previous && source.cacheKey) previous = await db.prepare(`SELECT json_extract(cache_key, '$[1]') AS scope_key,
        json_array_length(urls) AS accepted_count FROM source_feed_cache WHERE source_id = ?`).bind(source.id).first();
    if (previous?.scope_key === scope && !previous.allow_next
        && ((previous.accepted_count >= 5 && count === 0) || (previous.accepted_count >= 20 && count <= previous.accepted_count * 0.2))) {
        const warning = `Suspicious listing drop: ${previous.accepted_count} to ${count}. Snapshot held; saved listings will not be marked closed. Verify the employer board before accepting this change.`;
        await db.prepare(`INSERT INTO source_integrity(source_id, scope_key, accepted_count, warning) VALUES (?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET warning = excluded.warning`).bind(source.id, scope, previous.accepted_count, warning).run();
        throw new Error(warning);
    }
    return { count, scope };
}
export async function acceptFeedIntegrity(db, source, integrity) {
    await db.prepare(`INSERT INTO source_integrity(source_id, scope_key, accepted_count) VALUES (?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET scope_key = excluded.scope_key, accepted_count = excluded.accepted_count, warning = NULL, allow_next = 0`)
        .bind(source.id, integrity.scope, integrity.count).run();
}
export async function saveFiltered(db, source, feed, preferences, now) {
    const rejected = [];
    const classify = rejectionReason(preferences);
    for (const job of feed) {
        if (experienceLevel(job) !== 'internship') continue;
        const reason = classify(job);
        if (!reason) continue;
        rejected.push({ searchText: listingText(job), id: crypto.randomUUID(), url: canonicalizeUrl(job.url), title: job.title, company: job.company,
            location: job.location || 'Unspecified', reason, broad: Number(broadLocation(job)), skills: skillMask(job.title, job.description ?? '') });
    }
    await db.batch([
        db.prepare(`INSERT INTO filtered_listings(id, source_id, source_label, canonical_url, title, company, location, reason, broad_location, skill_mask, first_found_at, last_seen_at, search_text)
            SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.url'), json_extract(value, '$.title'), json_extract(value, '$.company'),
                json_extract(value, '$.location'), json_extract(value, '$.reason'), json_extract(value, '$.broad'), json_extract(value, '$.skills'), ?, ?, json_extract(value, '$.searchText')
            FROM json_each(?) WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE canonical_url = json_extract(value, '$.url'))
            ON CONFLICT(source_id, canonical_url) DO UPDATE SET title = excluded.title, company = excluded.company,
                location = excluded.location, reason = excluded.reason, broad_location = excluded.broad_location,
                search_text = excluded.search_text, skill_mask = excluded.skill_mask, last_seen_at = excluded.last_seen_at
            WHERE filtered_listings.search_text IS NOT excluded.search_text OR filtered_listings.title IS NOT excluded.title OR filtered_listings.company IS NOT excluded.company
                OR filtered_listings.location IS NOT excluded.location OR filtered_listings.reason IS NOT excluded.reason
                OR filtered_listings.broad_location != excluded.broad_location OR filtered_listings.skill_mask != excluded.skill_mask
                OR filtered_listings.last_seen_at < ?`)
            .bind(source.id, source.label, now, now, JSON.stringify(rejected), now.slice(0, 10)),
    ]);
    return new Set(rejected.map(job => job.url)).size;
}
export async function recordCheck(db, source, now, values) {
    await db.prepare(`INSERT INTO source_checks(source_id, checked_at, success, recovery, fetched, matched, filtered, inserted, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(source.id, now, Number(!values.error), Number(values.recovery ?? false), values.fetched ?? 0, values.matched ?? 0,
            values.filtered ?? 0, values.inserted ?? 0, values.error ?? null).run();
}
export async function cleanCoverage(db, now = Date.now()) {
    await db.batch([
        db.prepare('DELETE FROM source_checks WHERE checked_at < ?').bind(new Date(now - 8 * DAY).toISOString()),
        db.prepare('DELETE FROM filtered_listings WHERE last_seen_at < ? OR EXISTS (SELECT 1 FROM jobs WHERE jobs.canonical_url = filtered_listings.canonical_url)')
            .bind(new Date(now - 7 * DAY).toISOString()),
    ]);
}
export async function coverageReport(db, sources, day = pacificDay(Date.now()), now = Date.now()) {
    const [start, end] = dayBounds(day);
    const [checks, runs, overlap, startRow] = await Promise.all([
        db.prepare(`SELECT source_id AS sourceId, COUNT(*) AS attempts, SUM(success) AS successes,
            SUM(1-success) AS failures, SUM(CASE WHEN recovery = 1 AND success = 1 THEN 1 ELSE 0 END) AS recovered,
            SUM(fetched) AS fetched, SUM(matched) AS matched, SUM(filtered) AS filtered, SUM(inserted) AS discovered,
            MAX(CASE WHEN success = 1 THEN checked_at END) AS lastSuccessAt FROM source_checks
            WHERE checked_at >= ? AND checked_at < ? GROUP BY source_id`).bind(start, end).all(),
        db.prepare('SELECT source_id, last_success_at, error FROM source_runs').all(),
        db.prepare(`SELECT COUNT(*) AS count FROM (SELECT job_id FROM job_sources GROUP BY job_id HAVING COUNT(*) > 1)`).first(),
        db.prepare('SELECT MIN(checked_at) AS since FROM source_checks').first(),
    ]);
    const rows = sources.map(source => {
        const stats = checks.results.find(row => row.sourceId === source.id);
        const run = runs.results.find(row => row.source_id === source.id);
        return { sourceId: source.id, label: source.label, attempts: 0, successes: 0, failures: 0, recovered: 0, fetched: 0,
            matched: 0, filtered: 0, discovered: 0, ...stats,
            lastSuccessAt: run?.last_success_at ?? null,
            overdue: !run?.last_success_at || now - Date.parse(run.last_success_at) > 2 * 3600000,
            error: run?.error ?? null };
    });
    const totals = Object.fromEntries(['attempts', 'successes', 'failures', 'recovered', 'fetched', 'matched', 'filtered', 'discovered']
        .map(key => [key, rows.reduce((sum, row) => sum + row[key], 0)]));
    return { day, start, end, asOf: new Date(now).toISOString(), recordingSince: startRow?.since ?? null, sources: rows, totals,
        checked: rows.filter(row => row.attempts).length, total: rows.length, overlap: overlap.count,
        overdue: rows.filter(row => row.overdue).map(row => row.label) };
}
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function coverageApi(request, db, sources) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
        if (!['/api/coverage', '/api/filtered'].includes(url.pathname)) return json({ error: 'Method not allowed' }, 405);
        if (url.pathname === '/api/coverage') {
            const day = tokenKey(url.searchParams.get('day') ?? pacificDay(Date.now()));
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(`${day}T12:00:00Z`))
                || day > pacificDay(Date.now()) || day < pacificDay(Date.now() - 7 * DAY)
                || new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) !== day) return json({ error: 'Choose a date within the past seven days.' }, 400);
            return json(await coverageReport(db, sources, day));
        }
        const page = tokenKey(url.searchParams.get('page') ?? '1');
        const query = searchKey(url.searchParams.get('q') ?? '');
        const broad = tokenKey(url.searchParams.get('broad') ?? 'false');
        if (!/^[1-9]\d{0,4}$/.test(page) || query.length > 200 || !['true','false'].includes(broad)) return json({ error: 'Invalid review query' }, 400);
        const where = `last_seen_at >= ? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.canonical_url = filtered_listings.canonical_url)
            AND (? = 1 OR broad_location = 0) AND (? = '' OR instr(COALESCE(search_text, lower(title || ' ' || company || ' ' || location)), ?) > 0)`;
        const args = [new Date(Date.now() - 7 * DAY).toISOString(), Number(broad === 'true'), query, query];
        const [count, rows] = await db.batch([
            db.prepare(`SELECT COUNT(*) AS count FROM filtered_listings WHERE ${where}`).bind(...args),
            db.prepare(`SELECT * FROM filtered_listings WHERE ${where} ORDER BY last_seen_at DESC, id LIMIT 25 OFFSET ?`).bind(...args, (Number(page)-1)*25),
        ]);
        return json({ jobs: rows.results, total: count.results[0].count, page: Number(page) });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.id !== 'string' || body.id.length > 200 || Object.keys(body).length !== 1) return json({ error: 'Provide an ID' }, 400);
    if (url.pathname === '/api/coverage/accept-snapshot') {
        if (!sources.some(source => source.id === body.id)) return json({ error: 'Unknown source' }, 404);
        const result = await db.prepare('UPDATE source_integrity SET allow_next = 1 WHERE source_id = ? AND warning IS NOT NULL RETURNING source_id').bind(body.id).first();
        return result ? json({ accepted: true }) : json({ error: 'No held snapshot for this source' }, 409);
    }
    if (url.pathname !== '/api/filtered') return json({ error: 'Method not allowed' }, 405);
    const row = await db.prepare('SELECT * FROM filtered_listings WHERE id = ? AND last_seen_at >= ?').bind(body.id, new Date(Date.now() - 7 * DAY).toISOString()).first();
    if (!row) return json({ error: 'Review listing expired or was already saved' }, 404);
    const now = new Date().toISOString();
    const [, result] = await db.batch([
        db.prepare(`INSERT INTO jobs(id, canonical_url, title, company, location, source_label, first_found_at, last_seen_at, seen_at, skill_mask, search_text, title_key, is_intern)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(canonical_url) DO NOTHING`)
            .bind(crypto.randomUUID(), row.canonical_url, row.title, row.company, row.location, row.source_label, row.first_found_at, row.last_seen_at, now, row.skill_mask, listingText(row), textKey(row.title), 1),
        db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE canonical_url = ?`).bind(row.canonical_url),
        db.prepare(`INSERT INTO job_sources(job_id, source_id) SELECT jobs.id, source_id FROM filtered_listings JOIN jobs ON jobs.canonical_url = filtered_listings.canonical_url WHERE filtered_listings.canonical_url = ? ON CONFLICT(job_id, source_id) DO NOTHING`).bind(row.canonical_url),
        db.prepare('DELETE FROM filtered_listings WHERE canonical_url = ?').bind(row.canonical_url),
    ]);
    return json({ job: toJob(result.results[0]) });
}
