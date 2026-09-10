-- Share a short lease between manual and scheduled checks, including across isolates.
CREATE TABLE monitor_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
