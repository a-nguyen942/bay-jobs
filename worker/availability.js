// Called only after the entire source fetch and job writes succeed.
export async function recordAvailability(db, source, urls, now, matchedCount, cache = null) {
    const serializedUrls = urls === null ? null : JSON.stringify(urls);
    const token = crypto.randomUUID();
    await db.batch([
        // Establish provenance for jobs saved before availability tracking existed.
        db.prepare(`INSERT INTO job_sources (job_id, source_id)
            SELECT id, ? FROM jobs WHERE source_label = ? AND is_demo = 0
            ON CONFLICT(job_id, source_id) DO NOTHING`).bind(source.id, source.label),
        // Track all existing jobs present in the feed, even if preferences now exclude them.
        db.prepare(`INSERT INTO job_sources (job_id, source_id, last_check_token, missing_count)
            SELECT jobs.id, ?, ?, 0 FROM jobs JOIN json_each(COALESCE(?, (SELECT urls FROM source_feed_cache WHERE source_id = ?))) AS feed ON jobs.canonical_url = feed.value WHERE jobs.is_demo = 0
            ON CONFLICT(job_id, source_id) DO UPDATE SET last_check_token = excluded.last_check_token, missing_count = 0`)
            .bind(source.id, token, serializedUrls, source.id),
        ...(source.discoveryOnly ? [] : [db.prepare(`UPDATE job_sources SET missing_count = MIN(missing_count + 1, 2)
            WHERE missing_count < 2 AND source_id = ? AND (last_check_token IS NULL OR last_check_token != ?)`)
            .bind(source.id, token)]),
        db.prepare(`UPDATE jobs SET closed_at = CASE
            WHEN NOT EXISTS (SELECT 1 FROM job_sources WHERE job_id = jobs.id AND missing_count < 2)
            THEN COALESCE(closed_at, ?) ELSE NULL END
            WHERE id IN (SELECT job_id FROM job_sources WHERE source_id = ?)
            AND ((closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM job_sources WHERE job_id = jobs.id AND missing_count < 2))
                OR (closed_at IS NOT NULL AND EXISTS (SELECT 1 FROM job_sources WHERE job_id = jobs.id AND missing_count < 2)))`).bind(now, source.id),
        db.prepare(`INSERT INTO source_runs (source_id, last_attempt_at, last_success_at, matched_count, error)
            VALUES (?, ?, ?, ?, NULL) ON CONFLICT(source_id) DO UPDATE SET
            last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
            matched_count = excluded.matched_count, error = NULL, consecutive_failures = 0`).bind(source.id, now, now, matchedCount),
        ...(cache ? [db.prepare(`INSERT INTO source_feed_cache VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_id) DO UPDATE SET cache_key = excluded.cache_key, etag = excluded.etag,
            urls = excluded.urls, matched_count = excluded.matched_count, imported_at = excluded.imported_at`)
            .bind(source.id, cache.cacheKey, cache.etag, serializedUrls, matchedCount, now)] : []),
    ]);
}
