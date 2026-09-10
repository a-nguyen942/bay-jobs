CREATE TABLE notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  recipient TEXT NOT NULL DEFAULT '',
  cadence TEXT NOT NULL DEFAULT 'each_check' CHECK (cadence IN ('each_check', 'daily')),
  next_digest_at TEXT
);
--> statement-breakpoint
INSERT INTO notification_settings (id) VALUES (1);
--> statement-breakpoint
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivery_id TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX idx_notification_events_pending ON notification_events (created_at, id)
WHERE delivery_id IS NULL AND cancelled = 0;
--> statement-breakpoint
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  job_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  first_attempt_at TEXT,
  lease_until TEXT,
  provider_id TEXT,
  error TEXT
);
--> statement-breakpoint
CREATE INDEX idx_notification_deliveries_due ON notification_deliveries (status, next_attempt_at);
--> statement-breakpoint
CREATE TABLE notification_lock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
