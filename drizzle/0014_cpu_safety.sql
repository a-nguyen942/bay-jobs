CREATE TABLE work_budget_days (
    day TEXT PRIMARY KEY,
    reserved_ms INTEGER NOT NULL DEFAULT 0,
    manual_starts INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE work_budget_tracking (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    started_at TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO work_budget_tracking VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
