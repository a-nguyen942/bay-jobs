import { sourceWarning } from '../lib/source-health.js';
const checkTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
function timestamp(label, value) {
    const line = document.createElement('span');
    line.append(document.createTextNode(`${label}: `));
    if (value) {
        const time = document.createElement('time');
        time.dateTime = value;
        time.textContent = checkTime.format(new Date(value));
        line.append(time);
    } else line.append(document.createTextNode('Never'));
    return line;
}
export function createSourcePanel(onImport) {
    const form = document.getElementById('import-form');
    const message = document.getElementById('import-message');
    const panel = document.getElementById('backup-panel');
    panel.addEventListener('toggle', async () => {
        if (!panel.open) return;
        const list = document.getElementById('aggregator-status');
        try {
            const response = await fetch('/api/aggregators');
            if (!response.ok) throw new Error('unavailable');
            const providers = await response.json();
            list.replaceChildren(...providers.map(provider => {
                const row = document.createElement('li');
                row.textContent = `${provider.label}: ${!provider.enabled ? 'Not connected — free-plan API setup required' : provider.error ? `Last attempt failed: ${provider.error}` : provider.lastSuccessAt ? `${provider.matchedCount} matches; last success ${checkTime.format(new Date(provider.lastSuccessAt))}` : 'Connected — waiting for first scheduled check'}`;
                if (provider.enabled && provider.nextAttemptAt) row.append(`. Next eligible attempt: ${checkTime.format(new Date(provider.nextAttemptAt))}`);
                return row;
            }));
        } catch { list.textContent = 'Aggregator connection status unavailable. Try reopening this panel.'; }
    });
    let saving = false;
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (saving) return;
        const body = Object.fromEntries(new FormData(form));
        saving = true;
        for (const control of form.elements) control.disabled = true;
        message.hidden = false;
        message.classList.remove('error');
        message.textContent = 'Saving listing…';
        try {
            const response = await fetch('/api/jobs/import', { method: 'POST',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Could not save the listing.');
            form.reset();
            message.textContent = result.created ? 'Listing saved to your inbox.' : 'This listing is already saved. Its status and details have been preserved.';
            await onImport(result.job);
        } catch (error) {
            message.textContent = error instanceof Error ? error.message : 'Could not save the listing.';
            message.classList.add('error');
        } finally {
            saving = false;
            for (const control of form.elements) control.disabled = false;
        }
    });
    return {
        render(sources) {
            const list = document.getElementById('source-health');
            const notice = document.getElementById('source-health-warning');
            if (!sources) { list.textContent = 'Source status unavailable.'; notice.hidden = true; return; }
            const unhealthy = sources.filter(source => sourceWarning(source));
            notice.hidden = !unhealthy.length;
            notice.textContent = `${unhealthy.length} source(s) need attention. Warnings appear after a failed check, 3 consecutive failures, or over 2 hours without success. Sources with no successful check are also flagged.`;
            const rows = sources.map(source => {
                const row = document.createElement('li');
                const label = document.createElement('strong');
                label.textContent = source.label;
                const status = document.createElement('span');
                status.textContent = source.error ? `Failed: ${source.error}`
                    : source.lastSuccessAt ? `${source.matchedCount} matches at last successful check` : 'Waiting for first check';
                if (source.error) status.classList.add('source-check-error');
                const warning = document.createElement('span');
                warning.className = 'health-warning';
                warning.textContent = sourceWarning(source);
                warning.hidden = !warning.textContent;
                row.append(label, warning, timestamp('Last attempt', source.lastAttemptAt),
                    timestamp('Last successful check', source.lastSuccessAt), status);
                if (source.integrityWarning) {
                    const accept = document.createElement('button');
                    accept.className = 'text-button';
                    accept.textContent = source.acceptPending ? 'Next snapshot accepted — awaiting check' : 'I verified the board — accept next snapshot';
                    accept.disabled = source.acceptPending;
                    accept.addEventListener('click', async () => {
                        accept.disabled = true;
                        try {
                            const response = await fetch('/api/coverage/accept-snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: source.sourceId }) });
                            if (!response.ok) throw new Error('Could not accept snapshot. Refresh and retry.');
                            accept.textContent = 'Next snapshot accepted — awaiting check';
                        } catch (error) { accept.textContent = error.message; accept.disabled = false; }
                    });
                    row.append(accept);
                }
                return row;
            });
            list.replaceChildren(...rows);
            if (!rows.length) list.textContent = 'No automatic sources configured.';
        },
    };
}
