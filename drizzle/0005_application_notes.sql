ALTER TABLE jobs ADD COLUMN notes TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN follow_up_date TEXT;
--> statement-breakpoint
CREATE INDEX jobs_follow_up ON jobs(follow_up_date, first_found_at DESC, id) WHERE follow_up_date IS NOT NULL;
