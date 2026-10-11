CREATE TABLE filtered_listings (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_label TEXT NOT NULL,
    canonical_url TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT NOT NULL,
    location TEXT NOT NULL,
    reason TEXT NOT NULL,
    broad_location INTEGER NOT NULL DEFAULT 0,
    skill_mask INTEGER NOT NULL DEFAULT 0,
    first_found_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE(source_id, canonical_url)
);
--> statement-breakpoint
CREATE INDEX filtered_listings_seen ON filtered_listings(last_seen_at);
--> statement-breakpoint
CREATE TABLE source_integrity (
    source_id TEXT PRIMARY KEY,
    scope_key TEXT NOT NULL,
    accepted_count INTEGER NOT NULL,
    warning TEXT,
    allow_next INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE source_checks (
    id INTEGER PRIMARY KEY,
    source_id TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    recovery INTEGER NOT NULL DEFAULT 0,
    fetched INTEGER NOT NULL DEFAULT 0,
    matched INTEGER NOT NULL DEFAULT 0,
    filtered INTEGER NOT NULL DEFAULT 0,
    inserted INTEGER NOT NULL DEFAULT 0,
    error TEXT
);
--> statement-breakpoint
CREATE INDEX source_checks_time_source ON source_checks(checked_at, source_id);
--> statement-breakpoint
CREATE TABLE watchdog_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    ping_url TEXT,
    last_ping_at TEXT,
    error TEXT
);
--> statement-breakpoint
INSERT INTO watchdog_settings(id) VALUES(1);
