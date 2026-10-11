CREATE TABLE manual_scans (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    source_ids TEXT NOT NULL,
    next_index INTEGER NOT NULL DEFAULT 0,
    report TEXT NOT NULL DEFAULT '[]',
    expires_at TEXT NOT NULL
);
