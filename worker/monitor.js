import { INTERNSHIP_SQL } from '../lib/job-scope.js';
import { normalizeListing, listingText, textKey } from '../lib/text.js';
import { assertFeedIntegrity, acceptFeedIntegrity, saveFiltered, recordCheck } from './coverage.js';
import { skillMask } from '../lib/skills.js';
import { canonicalizeUrl, createMatcher, experienceLevel } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
import { getPreferences } from './preferences.js';
import { recordAvailability } from './availability.js';
export async function checkSources(db, sources, { recovery = false } = {}) {
    const report = [];
    const preferences = { ...searchPreferences, ...await getPreferences(db) };
    let matches;
    for (const source of sources) {
        const now = new Date().toISOString();
        let inserted = 0;
        let matched = 0;
        let fetched = 0;
        let filtered = 0;
        try {
            const previous = await db.prepare(source.cacheKey
                ? `SELECT runs.last_success_at, cache.cache_key, cache.etag, cache.matched_count, cache.imported_at
                    FROM source_runs AS runs LEFT JOIN source_feed_cache AS cache ON cache.source_id = runs.source_id
                    WHERE runs.source_id = ?`
                : 'SELECT last_success_at FROM source_runs WHERE source_id = ?').bind(source.id).first();
            // Bump this revision when adapter or matching semantics change.
            const cacheKey = JSON.stringify([4, source.cacheKey, preferences]);
            const cache = source.cacheKey && previous;
            // A full import each UTC day also preserves daily last-seen refreshes.
            const etag = previous?.last_success_at && cache?.cache_key === cacheKey
                && cache.imported_at.slice(0, 10) === now.slice(0, 10) ? cache.etag : null;
            // Persist before fetching/parsing: abrupt CPU termination must advance
            // rotation and leave a visible unfinished attempt, not starve sources.
            await db.prepare(`INSERT INTO source_runs (source_id, last_attempt_at, error)
                VALUES (?, ?, 'Check started but has not completed; it may have been interrupted by a runtime limit.')
                ON CONFLICT(source_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error = excluded.error`)
                .bind(source.id, now).run();
            let responseEtag = null;
            let feed = await source.fetchListings({ etag, onResponse: value => { responseEtag = value; } });
            if (feed === null) {
                if (!etag) throw new Error('Unchanged source has no committed snapshot');
                await recordAvailability(db, source, null, now, cache.matched_count);
                await db.prepare(`UPDATE filtered_listings SET last_seen_at = ? WHERE source_id = ? AND last_seen_at < ? AND canonical_url IN (SELECT value FROM json_each((SELECT urls FROM source_feed_cache WHERE source_id = ?)))`).bind(now, source.id, now.slice(0, 10), source.id).run();
                await db.prepare('UPDATE source_integrity SET warning = NULL, allow_next = 0 WHERE source_id = ?').bind(source.id).run();
                // An unchanged feed is a successful check, not another download.
                await recordCheck(db, source, now, { recovery, matched: cache.matched_count });
                report.push({ sourceId: source.id, inserted: 0, matched: cache.matched_count, error: null });
                continue;
            }
            if (!Array.isArray(feed)) throw new Error('Source response is not a complete listings array');
            if (feed.length > 10_000) throw new Error('Source exceeds the 10,000-listing safety limit; no partial snapshot was imported');
            feed = feed.map(normalizeListing);
            const integrity = await assertFeedIntegrity(db, source, feed);
            fetched = integrity.count;
            const urls = [...new Set(feed.map(job => canonicalizeUrl(job.url)))];
            const listings = feed.filter(matches ??= createMatcher(preferences));
            filtered = await saveFiltered(db, source, feed, preferences, now);
            // Validate before writing any records. Dedupe within this fetch too.
            const unique = new Map(listings.map(job => [canonicalizeUrl(job.url), job]));
            matched = unique.size;
            // One JSON parameter keeps SQL work bounded independently of feed size.
            // UUIDs identify rows inserted by this import, so only new jobs can queue alerts.
            const rows = [...unique.entries()].map(([url, job]) => ({
                isIntern: Number(experienceLevel(job) === 'internship'), searchText: listingText(job), titleKey: textKey(job.title), id: crypto.randomUUID(), url, title: job.title, company: job.company,
                location: job.location, postedAt: job.postedAt ?? null,
                skillMask: skillMask(job.title, job.description ?? ''), hasDescription: typeof job.description === 'string' && job.description.trim().length > 0,
            }));
            const payload = JSON.stringify(rows);
            const results = await db.batch([
                db.prepare(`INSERT INTO jobs (id, canonical_url, title, company, location, source_label, first_found_at, last_seen_at, posted_at, skill_mask, search_text, title_key, is_intern)
                    SELECT json_extract(value, '$.id'), json_extract(value, '$.url'), json_extract(value, '$.title'),
                        json_extract(value, '$.company'), json_extract(value, '$.location'), ?, ?, ?, json_extract(value, '$.postedAt'), json_extract(value, '$.skillMask'), json_extract(value, '$.searchText'), json_extract(value, '$.titleKey'), json_extract(value, '$.isIntern')
                    FROM json_each(?) WHERE true ON CONFLICT(canonical_url) DO NOTHING RETURNING id`)
                    .bind(source.label, now, now, payload),
                db.prepare(`INSERT INTO notification_events (id, job_id, title, company, url, created_at)
                    SELECT jobs.id, jobs.id, jobs.title, jobs.company, jobs.canonical_url, ?
                    FROM json_each(?) AS feed JOIN jobs ON jobs.id = json_extract(feed.value, '$.id')
                    WHERE jobs.is_demo = 0 AND ? = 1
                    AND EXISTS (SELECT 1 FROM notification_settings WHERE id = 1 AND enabled = 1
                        AND (skill_filter = 0 OR (
                            CASE WHEN skill_mode = 'all' THEN (jobs.skill_mask & notification_settings.skill_mask) = notification_settings.skill_mask ELSE (jobs.skill_mask & notification_settings.skill_mask) != 0 END
                            AND (internships_only = 0 OR ${INTERNSHIP_SQL})
                        )))
                    ON CONFLICT(job_id) DO NOTHING`).bind(now, payload, Number(Boolean(previous?.last_success_at))),
                db.prepare(`UPDATE jobs SET is_intern = json_extract(feed.value, '$.isIntern'), search_text = json_extract(feed.value, '$.searchText'), title_key = json_extract(feed.value, '$.titleKey'), title = json_extract(feed.value, '$.title'),
                    company = json_extract(feed.value, '$.company'), location = json_extract(feed.value, '$.location'),
                    skill_mask = CASE WHEN json_extract(feed.value, '$.hasDescription') THEN json_extract(feed.value, '$.skillMask') ELSE jobs.skill_mask | json_extract(feed.value, '$.skillMask') END,
                    last_seen_at = ?, posted_at = COALESCE(json_extract(feed.value, '$.postedAt'), jobs.posted_at)
                    FROM json_each(?) AS feed WHERE jobs.canonical_url = json_extract(feed.value, '$.url')
                    AND (jobs.is_intern IS NOT json_extract(feed.value, '$.isIntern') OR jobs.search_text IS NOT json_extract(feed.value, '$.searchText') OR jobs.title_key IS NOT json_extract(feed.value, '$.titleKey') OR jobs.skill_mask != CASE WHEN json_extract(feed.value, '$.hasDescription') THEN json_extract(feed.value, '$.skillMask') ELSE jobs.skill_mask | json_extract(feed.value, '$.skillMask') END
                        OR jobs.title IS NOT json_extract(feed.value, '$.title')
                        OR jobs.company IS NOT json_extract(feed.value, '$.company')
                        OR jobs.location IS NOT json_extract(feed.value, '$.location')
                        OR (json_extract(feed.value, '$.postedAt') IS NOT NULL AND jobs.posted_at IS NOT json_extract(feed.value, '$.postedAt'))
                        OR jobs.last_seen_at < ?)`)
                    .bind(now, payload, now.slice(0, 10)),
            ]);
            inserted = results[0].results.length;
            await recordAvailability(db, source, urls, now, unique.size, source.cacheKey ? { cacheKey, etag: responseEtag } : null);
            await acceptFeedIntegrity(db, source, integrity);
            await recordCheck(db, source, now, { recovery, fetched, matched, filtered, inserted });
            report.push({ sourceId: source.id, inserted, matched: unique.size, error: null });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown source error';
            await db.prepare(`INSERT INTO source_runs (source_id, last_attempt_at, error, consecutive_failures) VALUES (?, ?, ?, 1)
        ON CONFLICT(source_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error = excluded.error, consecutive_failures = MIN(source_runs.consecutive_failures + 1, 1000)`).bind(source.id, now, message).run();
            await recordCheck(db, source, now, { recovery, fetched, matched, filtered, inserted, error: message });
            report.push({ sourceId: source.id, inserted, matched, error: message });
        }
    }
    return report;
}
