CREATE TABLE search_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    preferences TEXT NOT NULL
);
--> statement-breakpoint
ALTER TABLE jobs ADD COLUMN closed_at TEXT;
--> statement-breakpoint
CREATE TABLE job_sources (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    last_check_token TEXT,
    missing_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (job_id, source_id)
);
--> statement-breakpoint
CREATE INDEX job_sources_source ON job_sources(source_id);
