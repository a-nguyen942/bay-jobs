import { searchKey } from '../lib/text.js';
import { INTERNSHIP_SQL, REVIEW_SQL } from '../lib/job-scope.js';
import { SKILLS, ALL_SKILLS } from '../lib/skills.js';
export const JOB_COLUMNS = `id, canonical_url AS canonicalUrl, title, company, location,
  source_label AS sourceLabel, first_found_at AS firstFoundAt, last_seen_at AS lastSeenAt,
  posted_at AS postedAt, seen_at AS seenAt, application_status AS applicationStatus, is_demo AS isDemo, closed_at AS closedAt,
  is_favorite AS isFavorite, deadline_date AS deadlineDate, skill_mask AS skillMask, notes, follow_up_date AS followUpDate`;
export function toJob(row) { return { ...row, isDemo: Boolean(row.isDemo), isFavorite: Boolean(row.isFavorite) }; }
export async function listJobs(db, query) {
    const pageSize = 50;
    const clauses = [];
    const values = [];
    if (query.view === 'all')
        clauses.push("application_status != 'archived'");
    else if (query.view === 'new')
        clauses.push("seen_at IS NULL AND application_status != 'archived'");
    else if (query.view === 'seen')
        clauses.push("seen_at IS NOT NULL AND application_status != 'archived'");
    else if (query.view === 'review')
        clauses.push(REVIEW_SQL);
    else if (query.view === 'favorites')
        clauses.push("is_favorite = 1 AND application_status != 'archived'");
    else if (query.view === 'deadlines')
        clauses.push("deadline_date IS NOT NULL AND application_status != 'archived'");
    else if (query.view === 'follow_up')
        clauses.push("follow_up_date IS NOT NULL AND application_status != 'archived'");
    else {
        clauses.push('application_status = ?');
        values.push(query.view);
    }
    if (query.hideClosed) clauses.push('closed_at IS NULL');
    if (query.query) {
        // Literal substring search: percent signs, underscores, and quotes are ordinary text.
        clauses.push("instr(COALESCE(search_text, lower(title || ' ' || company || ' ' || location)), ?) > 0");
        values.push(searchKey(query.query));
    }
    if (query.internships) clauses.push(INTERNSHIP_SQL);
    if (query.view !== 'review' && ['any', 'all'].includes(query.skillMode)) {
        clauses.push(query.skillMode === 'all' ? '(skill_mask & ?) = ?' : '(skill_mask & ?) != 0');
        values.push(query.skills ?? 0);
        if (query.skillMode === 'all') values.push(query.skills ?? 0);
    }
    const where = clauses.join(' AND ');
    const mask = query.skills ?? ALL_SKILLS;
    const score = SKILLS.filter(skill => mask & skill.bit).map(skill => `((skill_mask & ${skill.bit}) != 0)`).join(' + ') || '0 + 0';
    const order = query.sort === 'deadline' || query.view === 'deadlines'
        ? 'deadline_date IS NULL ASC, deadline_date ASC, first_found_at DESC, id ASC'
        : query.sort === 'importance'
        ? `${INTERNSHIP_SQL} DESC, (${score}) DESC, first_found_at DESC, id ASC`
        : query.view === 'follow_up' ? 'follow_up_date ASC, first_found_at DESC, id ASC' : 'first_found_at DESC, id ASC';
    const [count, rows, summary] = await db.batch([
        db.prepare(`SELECT COUNT(*) AS total FROM jobs WHERE ${where}`).bind(...values),
        db.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...values, pageSize, (query.page - 1) * pageSize),
        db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(seen_at IS NULL AND application_status != 'archived'), 0) AS unseen,
      COALESCE(SUM(is_demo = 1), 0) AS demo,
      COALESCE(SUM(${REVIEW_SQL}), 0) AS needsReview FROM jobs`),
    ]);
    const total = Number(count.results[0].total);
    return {
        jobs: rows.results.map(toJob),
        pagination: { page: query.page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) },
        summary: summary.results[0],
    };
}
