const DAY = 86_400_000;
export const EMAIL_DAILY_LIMIT = 100;
export const EMAIL_MONTHLY_LIMIT = 3000;
// Rolling windows deliberately avoid dependence on the provider's billing reset date.
export async function emailBudget(db, now = Date.now()) {
    const row = await db.prepare(`SELECT
        COUNT(CASE WHEN attempted_at > ? THEN 1 END) AS dailyUsed,
        COUNT(*) AS monthlyUsed,
        MIN(CASE WHEN attempted_at > ? THEN attempted_at END) AS oldestDaily,
        MIN(attempted_at) AS oldestMonthly
        FROM email_attempt_budget WHERE attempted_at > ?`)
        .bind(now - DAY, now - DAY, now - 31 * DAY).first();
    const resume = Math.max(row.dailyUsed >= EMAIL_DAILY_LIMIT ? row.oldestDaily + DAY : 0,
        row.monthlyUsed >= EMAIL_MONTHLY_LIMIT ? row.oldestMonthly + 31 * DAY : 0);
    return { dailyUsed: row.dailyUsed, dailyLimit: EMAIL_DAILY_LIMIT,
        monthlyUsed: row.monthlyUsed, monthlyLimit: EMAIL_MONTHLY_LIMIT,
        resumeAt: resume ? new Date(resume).toISOString() : null };
}
export async function reserveEmailAttempt(db, now) {
    // Conditional INSERT is atomic even across processes. Reserve before network I/O;
    // failures and crashes consume allowance rather than risking extra sends.
    const result = await db.prepare(`INSERT INTO email_attempt_budget (attempted_at)
        SELECT ? WHERE (SELECT COUNT(*) FROM email_attempt_budget WHERE attempted_at > ?) < ?
        AND (SELECT COUNT(*) FROM email_attempt_budget WHERE attempted_at > ?) < ? RETURNING id`)
        .bind(now, now - DAY, EMAIL_DAILY_LIMIT, now - 31 * DAY, EMAIL_MONTHLY_LIMIT).first();
    return Boolean(result);
}
