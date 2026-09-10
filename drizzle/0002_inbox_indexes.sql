CREATE INDEX idx_jobs_discovery_order ON jobs (first_found_at DESC, id ASC);
--> statement-breakpoint
CREATE INDEX idx_jobs_status_order ON jobs (application_status, first_found_at DESC, id ASC);
--> statement-breakpoint
CREATE INDEX idx_jobs_unseen_order ON jobs (first_found_at DESC, id ASC)
WHERE seen_at IS NULL AND application_status != 'archived';
--> statement-breakpoint
DROP INDEX idx_jobs_first_found_at;
