const localDate = (now = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const el = id => document.getElementById(id);
const node = (tag, text) => { const item = document.createElement(tag); item.textContent = text; return item; };
const stamp = value => value ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : 'Never';
async function api(path, body) {
    const response = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load coverage data');
    return result;
}
let reportRevision = 0;
el('coverage-day').value = localDate();
el('coverage-day').max = localDate();
el('coverage-day').min = localDate(Date.now() - 7 * 86400000);
async function report() {
    const revision = ++reportRevision;
    el('coverage-message').textContent = 'Loading coverage…';
    try {
        const data = await api(`/api/coverage?day=${encodeURIComponent(el('coverage-day').value)}`);
        if (revision !== reportRevision) return;
        el('coverage-message').textContent = `${data.day}: ${data.checked}/${data.total} sources checked · ${data.overdue.length} overdue now. Recording since ${stamp(data.recordingSince)} Pacific.`;
        el('coverage-totals').textContent = `${data.totals.discovered} new listings saved · ${data.totals.failures} failed checks · ${data.totals.recovered} successful recovery checks · ${data.overlap} saved listings found on multiple sources.`;
        el('coverage-rows').replaceChildren(...data.sources.map(source => {
            const row = node('tr', '');
            for (const value of [source.label, `${source.attempts} / ${source.failures}`, source.recovered, source.fetched, source.filtered, source.discovered,
                source.overdue ? 'Overdue' : source.error ? 'Latest check failed' : 'Recent success']) row.append(node('td', value));
            return row;
        }));
    } catch (error) { if (revision === reportRevision) el('coverage-message').textContent = error.message; }
}
el('coverage-panel').addEventListener('toggle', () => { if (el('coverage-panel').open) void report(); });
el('coverage-refresh').addEventListener('click', report);
el('coverage-day').addEventListener('change', report);
let page = 1, reviewRevision = 0, preferencesLoaded = false;
async function candidates() {
    const revision = ++reviewRevision;
    el('rejected-message').textContent = 'Loading review candidates…';
    try {
        if (!preferencesLoaded) {
            const { preferences } = await api('/api/preferences');
            if (revision !== reviewRevision) return;
            el('rejected-broad').checked = preferences.reviewBroadLocations;
            preferencesLoaded = true;
        }
        const data = await api(`/api/filtered?${new URLSearchParams({ page, q: el('rejected-query').value, broad: el('rejected-broad').checked })}`);
        if (revision !== reviewRevision) return;
        if (!data.jobs.length && page > 1) { page--; return candidates(); }
        el('rejected-message').textContent = `${data.total} candidates. Broad-location candidates are ${el('rejected-broad').checked ? 'included' : 'hidden; enable the checkbox to review them'}.`;
        el('rejected-page').textContent = `Page ${data.page} of ${Math.max(1, Math.ceil(data.total / 25))}`;
        el('rejected-prev').disabled = page === 1;
        el('rejected-next').disabled = page * 25 >= data.total;
        el('rejected-list').replaceChildren(...data.jobs.map(job => {
            const row = node('li', '');
            const link = node('a', `${job.title} — ${job.company}`);
            link.href = job.canonical_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
            const save = node('button', 'Save to inbox'); save.className = 'secondary';
            save.addEventListener('click', async () => {
                save.disabled = true;
                try { await api('/api/filtered', { id: job.id }); await candidates(); window.dispatchEvent(new Event('coverage-imported')); }
                catch (error) { el('rejected-message').textContent = error.message; save.disabled = false; }
            });
            row.append(link, node('p', `${job.location} · ${job.reason}`), node('p', `${job.source_label} · First found ${stamp(job.first_found_at)} · Last recorded ${stamp(job.last_seen_at)} Pacific`), save);
            return row;
        }));
    } catch (error) { if (revision === reviewRevision) el('rejected-message').textContent = error.message; }
}
el('rejected-panel').addEventListener('toggle', () => { if (el('rejected-panel').open) void candidates(); });
for (const id of ['rejected-query', 'rejected-broad']) el(id).addEventListener('change', () => { page = 1; void candidates(); });
el('rejected-refresh').addEventListener('click', candidates);
el('rejected-prev').addEventListener('click', () => { if (page > 1) { page--; void candidates(); } });
el('rejected-next').addEventListener('click', () => { page++; void candidates(); });
window.addEventListener('preferences-saved', () => { preferencesLoaded = false; page = 1; if (el('rejected-panel').open) void candidates(); });
let watchdogBusy = false;
async function watchdog(body) {
    if (watchdogBusy) return;
    watchdogBusy = true;
    for (const field of el('watchdog-form').elements) field.disabled = true;
    try {
        const data = await api('/api/watchdog', body);
        el('watchdog-status').textContent = data.configured ? `Connected · Last confirmed heartbeat: ${stamp(data.lastPingAt)} Pacific. ${data.error ?? 'Verify alert delivery in your external monitor.'}` : 'Not connected — external monitoring is not active. Complete the setup below.';
        if (body !== undefined) el('watchdog-url').value = '';
    } catch (error) { el('watchdog-status').textContent = error.message; }
    finally { watchdogBusy = false; for (const field of el('watchdog-form').elements) field.disabled = false; }
}
el('backup-panel').addEventListener('toggle', () => { if (el('backup-panel').open) void watchdog(); });
el('watchdog-form').addEventListener('submit', event => { event.preventDefault(); void watchdog({ pingUrl: el('watchdog-url').value.trim() }); });
el('watchdog-disconnect').addEventListener('click', () => { void watchdog({ pingUrl: null }); });
