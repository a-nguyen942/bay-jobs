CREATE TABLE source_feed_cache (
    source_id TEXT PRIMARY KEY,
    cache_key TEXT NOT NULL,
    etag TEXT,
    urls TEXT NOT NULL,
    matched_count INTEGER NOT NULL,
    imported_at TEXT NOT NULL
);
