CREATE TABLE email_attempt_budget (
    id INTEGER PRIMARY KEY,
    attempted_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX email_attempt_budget_time ON email_attempt_budget(attempted_at);
--> statement-breakpoint
-- Preserve known historical attempts conservatively when upgrading.
-- Historical retries lack individual timestamps. Charge recent attempts at
-- migration time, conservatively, rather than guessing when allowance expires.
INSERT INTO email_attempt_budget (attempted_at)
WITH RECURSIVE attempts_left(n) AS (
    SELECT attempts FROM notification_deliveries WHERE attempts > 0
    AND first_attempt_at > datetime('now', '-32 days')
    UNION ALL SELECT n - 1 FROM attempts_left WHERE n > 1
)
SELECT CAST(unixepoch('now') AS INTEGER) * 1000 FROM attempts_left;
--> statement-breakpoint
CREATE TABLE manual_check_budget (id INTEGER PRIMARY KEY CHECK (id = 1), next_allowed_at INTEGER NOT NULL);
