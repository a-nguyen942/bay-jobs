// Reservations are deliberately pessimistic, NOT measured/billed CPU.
// Keep CPU_PER_INVOCATION_MS equal to wrangler.json limits.cpu_ms.
export const CPU_PER_INVOCATION_MS = 500;
export const CPU_WARNING_MS = 15_000_000;
export const CPU_STOP_MS = 21_000_000;
export const MANUAL_STARTS_PER_DAY = 10;
const DAY = 86_400_000;
function dates(now) {
    return { today: new Date(now).toISOString().slice(0, 10),
        // Include the entire oldest UTC day: a conservative rounding of 31 days.
        oldest: new Date(now - 31 * DAY).toISOString().slice(0, 10) };
}
export class CpuBudgetError extends Error {
    constructor(message, retryAfter = 3600) { super(message); this.retryAfter = retryAfter; }
}
export async function cpuBudget(db, now = Date.now()) {
    const { today, oldest } = dates(now);
    const rows = (await db.prepare('SELECT day, reserved_ms, manual_starts FROM work_budget_days WHERE day >= ? ORDER BY day').bind(oldest).all()).results;
    const reservedMs = rows.reduce((sum, row) => sum + row.reserved_ms, 0);
    const paused = reservedMs + CPU_PER_INVOCATION_MS > CPU_STOP_MS;
    let remaining = reservedMs;
    let resumeAt = null;
    if (paused) for (const row of rows) {
        remaining -= row.reserved_ms;
        if (remaining + CPU_PER_INVOCATION_MS <= CPU_STOP_MS) {
            resumeAt = new Date(Date.parse(row.day) + 32 * DAY).toISOString(); break;
        }
    }
    const started = await db.prepare('SELECT started_at FROM work_budget_tracking WHERE id = 1').first();
    return { reservedMs, warningMs: CPU_WARNING_MS, stopMs: CPU_STOP_MS,
        perInvocationMs: CPU_PER_INVOCATION_MS, warning: reservedMs >= CPU_WARNING_MS, paused, resumeAt,
        manualStarts: rows.find(row => row.day === today)?.manual_starts ?? 0,
        manualDailyLimit: MANUAL_STARTS_PER_DAY,
        manualResetAt: new Date(Date.parse(today) + DAY).toISOString(), startedAt: started?.started_at ?? null };
}
export async function reserveWork(db, now = Date.now(), { manualStart = false } = {}) {
    const { today, oldest } = dates(now);
    const cost = manualStart ? 0 : CPU_PER_INVOCATION_MS;
    // One atomic statement arbitrates concurrent invocations. Never refund a
    // reservation: CPU-limit termination cannot execute a finally block.
    const row = await db.prepare(`INSERT INTO work_budget_days (day, reserved_ms, manual_starts)
        SELECT ?, ?, ? WHERE
            (SELECT COALESCE(SUM(reserved_ms), 0) FROM work_budget_days WHERE day >= ?) + ? <= ?
            AND (? = 0 OR COALESCE((SELECT manual_starts FROM work_budget_days WHERE day = ?), 0) < ?)
        ON CONFLICT(day) DO UPDATE SET reserved_ms = reserved_ms + excluded.reserved_ms,
            manual_starts = manual_starts + excluded.manual_starts RETURNING day`)
        .bind(today, cost, Number(manualStart), oldest, cost, CPU_STOP_MS,
            Number(manualStart), today, MANUAL_STARTS_PER_DAY).first();
    if (!row) {
        const status = await cpuBudget(db, now);
        if (manualStart && status.manualStarts >= MANUAL_STARTS_PER_DAY)
            throw new CpuBudgetError('Daily limit of 10 manual scan starts reached. Automatic hourly scans continue.',
                Math.max(1, Math.ceil((Date.parse(status.manualResetAt) - now) / 1000)));
        throw new CpuBudgetError('CPU safety budget reached. Automatic scans and changes are paused; saved listings remain readable. Checks resume as older reservations expire.',
            Math.max(1, Math.ceil(((Date.parse(status.resumeAt) || now + 3_600_000) - now) / 1000)));
    }
}
export async function cleanCpuBudget(db, now = Date.now()) {
    await db.prepare('DELETE FROM work_budget_days WHERE day < ?').bind(dates(now).oldest).run();
}
