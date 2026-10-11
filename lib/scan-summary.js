const HOUR = 60 * 60 * 1000;
export function hourStart(now = Date.now()) {
    return new Date(Math.floor(now / HOUR) * HOUR).toISOString();
}
/** Latest completed outcome per configured source in this hour, including manual checks. */
export function scanSummary(sources, newMatches, now = Date.now()) {
    const startedAt = hourStart(now);
    const current = sources.filter(source => source.lastAttemptAt >= startedAt && Date.parse(source.lastAttemptAt) <= now);
    const failed = current.filter(source => source.error);
    const successful = current.filter(source => !source.error && source.lastSuccessAt >= startedAt);
    const checkedIds = new Set([...failed, ...successful].map(source => source.sourceId));
    const waiting = sources.filter(source => !checkedIds.has(source.sourceId));
    const windowEnded = now - Date.parse(startedAt) >= sources.length * 60 * 1000;
    const status = !sources.length ? 'unconfigured'
        : !waiting.length ? failed.length ? 'finished_with_errors' : 'complete'
        : windowEnded ? 'incomplete' : 'waiting';
    return { startedAt, expectedFinishMinute: sources.length, recoveryFinishMinute: sources.length * 2, retryWindowOpen: windowEnded && now - Date.parse(startedAt) < sources.length * 2 * 60_000, asOf: new Date(now).toISOString(), status, total: sources.length,
        checked: checkedIds.size, succeeded: successful.length, failed: failed.length,
        waiting: waiting.length, newMatches: Number(newMatches),
        failedSources: failed.map(source => source.label), waitingSources: waiting.map(source => source.label) };
}
