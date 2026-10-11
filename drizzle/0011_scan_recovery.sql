CREATE TABLE scan_retries (
    hour_start TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (hour_start, source_id)
);
--> statement-breakpoint
ALTER TABLE notification_settings ADD COLUMN scan_alerts INTEGER NOT NULL DEFAULT 1 CHECK (scan_alerts IN (0, 1));
