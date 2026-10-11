// Fixed SQL fragments; no request text is interpolated here.
export const INTERNSHIP_SQL = "COALESCE(is_intern, ((' ' || COALESCE(title_key, lower(title)) || ' ') GLOB '* intern[^a-z]*' OR (' ' || COALESCE(title_key, lower(title)) || ' ') GLOB '* internship[^a-z]*' OR (' ' || COALESCE(title_key, lower(title)) || ' ') GLOB '* internships[^a-z]*' OR COALESCE(title_key, lower(title)) GLOB '*co-op*' OR COALESCE(title_key, lower(title)) GLOB '*co op*'))";
export const REVIEW_SQL = `skill_mask = 0 AND application_status != 'archived' AND ${INTERNSHIP_SQL}`;
