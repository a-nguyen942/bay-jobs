export const JOB_COLUMNS = `id, canonical_url AS canonicalUrl, title, company, location,
  source_label AS sourceLabel, first_found_at AS firstFoundAt, last_seen_at AS lastSeenAt,
  posted_at AS postedAt, seen_at AS seenAt, application_status AS applicationStatus, is_demo AS isDemo`;
export function toJob(row) { return { ...row, isDemo: Boolean(row.isDemo) }; }
export async function listJobs(db, query) {
    const pageSize = 50;
    const clauses = [];
    const values = [];
    if (query.view === 'all')
        clauses.push("application_status != 'archived'");
    else if (query.view === 'new')
        clauses.push("seen_at IS NULL AND application_status != 'archived'");
    else {
        clauses.push('application_status = ?');
        values.push(query.view);
    }
    if (query.query) {
        // Literal substring search: percent signs, underscores, and quotes are ordinary text.
        clauses.push("instr(lower(title || ' ' || company || ' ' || location), lower(?)) > 0");
        values.push(query.query);
    }
    const where = clauses.join(' AND ');
    const [count, rows, summary] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE ${where}`).bind(...values),
        db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE ${where} ORDER BY first_found_at DESC, id ASC LIMIT ? OFFSET ?`).bind(...values, pageSize, (query.page - 1) * pageSize),
        db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(seen_at IS NULL AND application_status != 'archived'), 0) AS unseen,
      COALESCE(SUM(is_demo = 1), 0) AS demo FROM jobs`),
    ]);
    const total = Number(count.results[0].total);
    return {
        jobs: rows.results.map(toJob),
        pagination: { page: query.page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
        summary: summary.results[0],
    };
}
