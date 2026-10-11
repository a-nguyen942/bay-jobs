const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
export function renderCpuSafety(safety, stale = false) {
    const title = document.getElementById('cpu-safety-title');
    const status = document.getElementById('cpu-safety-status');
    const detail = document.getElementById('cpu-safety-detail');
    if (!safety) { title.textContent = 'CPU safety · status unavailable'; status.textContent = 'Refresh the inbox to check safety limits.'; detail.textContent = ''; return; }
    const manualLimited = safety.manualStarts >= safety.manualDailyLimit;
    title.textContent = `CPU safety · ${stale ? 'last received status' : safety.paused ? 'scanning paused' : safety.warning ? 'approaching work budget' : 'limits active'}`;
    status.textContent = safety.paused
        ? `Scans and changes are paused to protect the work budget. Saved listings remain readable. New listings may be missed during this pause.${safety.resumeAt ? ` Earliest automatic resumption: ${time.format(new Date(safety.resumeAt))}.` : ''}`
        : manualLimited ? `Manual scan limit reached. Automatic hourly scans continue. Manual starts reset ${time.format(new Date(safety.manualResetAt))}.`
        : safety.warning ? 'The reserved work estimate is above the warning threshold. Scans continue until the pause threshold is reached.'
        : 'Automatic hourly scans remain active. Each invocation has a 500 ms CPU limit.';
    detail.textContent = `${(safety.reservedMs / 1_000_000).toFixed(2)} million CPU-ms reserved; warning at 15 million, pause at 21 million. Manual starts today: ${safety.manualStarts}/${safety.manualDailyLimit}.${safety.startedAt ? ` Tracking began ${time.format(new Date(safety.startedAt))}.` : ''}${stale ? ' Status may be out of date; refresh failed.' : ''}`;
    status.classList.toggle('error', safety.paused || safety.warning);
    if (safety.paused || safety.warning || manualLimited) document.getElementById('cpu-safety-panel').open = true;
}
