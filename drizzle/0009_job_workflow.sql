ALTER TABLE jobs ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1));
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN deadline_date TEXT;
--> statement-breakpoint
ALTER TABLE source_runs ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE notification_settings ADD COLUMN skill_filter INTEGER NOT NULL DEFAULT 0 CHECK (skill_filter IN (0, 1));
--> statement-breakpoint
ALTER TABLE notification_settings ADD COLUMN skill_mask INTEGER NOT NULL DEFAULT 63 CHECK (skill_mask BETWEEN 0 AND 63);
--> statement-breakpoint
ALTER TABLE notification_settings ADD COLUMN skill_mode TEXT NOT NULL DEFAULT 'any' CHECK (skill_mode IN ('any', 'all'));
--> statement-breakpoint
ALTER TABLE notification_settings ADD COLUMN internships_only INTEGER NOT NULL DEFAULT 0 CHECK (internships_only IN (0, 1));
--> statement-breakpoint
ALTER TABLE notification_deliveries ADD COLUMN kind TEXT NOT NULL DEFAULT 'matches';
--> statement-breakpoint
UPDATE notification_deliveries SET kind = 'test' WHERE job_count = 0;
