CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_url` text NOT NULL,
	`title` text NOT NULL,
	`company` text NOT NULL,
	`location` text NOT NULL,
	`source_label` text NOT NULL,
	`first_found_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`posted_at` text,
	`seen_at` text,
	`application_status` text DEFAULT 'considering' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	CONSTRAINT "jobs_application_status" CHECK("jobs"."application_status" IN ('considering', 'applied', 'interviewing', 'rejected', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_canonical_url_unique` ON `jobs` (`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_jobs_first_found_at` ON `jobs` (`first_found_at`);--> statement-breakpoint
CREATE TABLE `source_runs` (
	`source_id` text PRIMARY KEY NOT NULL,
	`last_attempt_at` text NOT NULL,
	`last_success_at` text,
	`error` text,
	`matched_count` integer DEFAULT 0 NOT NULL
);
