import { canonicalizeUrl, matchesSearch } from '../lib/matching.js';
import { searchPreferences } from '../config/search.js';
export async function checkSources(db, sources) {
    const report = [];
    for (const source of sources) {
        const now = new Date().toISOString();
        let inserted = 0;
        let matched = 0;
        try {
            const previous = await db.prepare('SELECT last_success_at FROM source_runs WHERE source_id = ?').bind(source.id).first();
            const listings = (await source.fetchListings()).filter(job => matchesSearch(job, searchPreferences));
            // Validate before writing any records. Dedupe within this fetch too.
            const unique = new Map(listings.map(job => [canonicalizeUrl(job.url), job]));
            matched = unique.size;
            const rows = [...unique.entries()];
            for (let start = 0; start < rows.length; start += 25) {
                const chunk = rows.slice(start, start + 25);
                const statements = chunk.flatMap(([url, job]) => {
                    const id = crypto.randomUUID();
                    return [
                        db.prepare(`INSERT INTO jobs (id, canonical_url, title, company, location, source_label, first_found_at, last_seen_at, posted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(canonical_url) DO NOTHING RETURNING id`)
                            .bind(id, url, job.title, job.company, job.location, source.label, now, now, job.postedAt),
                        // The new UUID exists only if this insert won. Job + event commit together.
                        db.prepare(`INSERT INTO notification_events (id, job_id, title, company, url, created_at)
              SELECT ?, id, title, company, canonical_url, ? FROM jobs
              WHERE id = ? AND is_demo = 0 AND ? = 1
              AND EXISTS (SELECT 1 FROM notification_settings WHERE id = 1 AND enabled = 1)
              ON CONFLICT(job_id) DO NOTHING`)
                            .bind(crypto.randomUUID(), now, id, Number(Boolean(previous?.last_success_at))),
                    ];
                });
                const results = await db.batch(statements);
                results.forEach((result, index) => { if (index % 2 === 0 && result.results.length)
                    inserted++; });
                // Refresh source-owned fields without touching seen/application state or first discovery.
                await db.batch(chunk.map(([url, job]) => db.prepare(`
          UPDATE jobs SET title = ?, company = ?, location = ?, last_seen_at = ?, posted_at = COALESCE(?, posted_at)
          WHERE canonical_url = ?
        `).bind(job.title, job.company, job.location, now, job.postedAt, url)));
            }
            await db.prepare(`INSERT INTO source_runs (source_id, last_attempt_at, last_success_at, matched_count, error)
        VALUES (?, ?, ?, ?, NULL) ON CONFLICT(source_id) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at,
        matched_count = excluded.matched_count, error = NULL`).bind(source.id, now, now, unique.size).run();
            report.push({ sourceId: source.id, inserted, matched: unique.size, error: null });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown source error';
            await db.prepare(`INSERT INTO source_runs (source_id, last_attempt_at, error) VALUES (?, ?, ?)
        ON CONFLICT(source_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error = excluded.error`).bind(source.id, now, message).run();
            report.push({ sourceId: source.id, inserted, matched, error: message });
        }
    }
    return report;
}
