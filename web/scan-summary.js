const hour = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', timeZoneName: 'short',
});
const updatedTime = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export function renderScanSummary(scan, hasError = false) {
    const title = document.getElementById('scan-summary-title');
    const status = document.getElementById('scan-summary-status');
    const counts = document.getElementById('scan-summary-counts');
    const detail = document.getElementById('scan-summary-detail');
    const progress = document.getElementById('scan-summary-progress');
    title.parentElement.dataset.status = scan?.status ?? 'loading';
    if (!scan) {
        title.textContent = 'This hour’s source scan';
        status.textContent = hasError ? 'Scan status unavailable. Refresh to try again.' : 'Loading scan progress…';
        counts.textContent = detail.textContent = '';
        progress.hidden = true;
        return;
    }
    document.getElementById('scan-finish-time').textContent = scan.total ? `Regular checks finish around :${String(scan.expectedFinishMinute).padStart(2, '0')}; recovery runs until :${String(scan.recoveryFinishMinute).padStart(2, '0')}.` : '';
    title.textContent = `This hour’s source scan · ${hour.format(new Date(scan.startedAt))}`;
    const labels = { unconfigured: 'No automatic sources configured', complete: 'Scan complete',
        finished_with_errors: 'All sources checked · some failed', incomplete: 'Scan incomplete · results still missing',
        waiting: 'Waiting for this hour’s check results' };
    status.textContent = `${scan.retryWindowOpen && scan.status !== 'complete' ? 'Recovery window · retrying failed or missing checks' : labels[scan.status]}${scan.total ? ` — ${scan.checked}/${scan.total} sources checked` : ''}`;
    progress.hidden = !scan.total;
    progress.max = scan.total || 1;
    progress.value = scan.checked;
    counts.textContent = `${scan.succeeded} succeeded · ${scan.failed} failed · ${scan.waiting} awaiting results · ${scan.newMatches} new ${scan.newMatches === 1 ? 'match' : 'matches'}`;
    detail.textContent = [`Updated ${updatedTime.format(new Date(scan.asOf))}.`, scan.failedSources.length ? `Failed: ${scan.failedSources.join(', ')}.` : '',
        scan.waitingSources.length ? `Awaiting results: ${scan.waitingSources.join(', ')}.` : '',
        hasError ? 'Showing the last received summary; see the inbox message for the current issue.' : ''].filter(Boolean).join(' ');
}
