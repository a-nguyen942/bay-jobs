import { SKILLS } from '../lib/skills.js';
function node(id) {
    const element = document.getElementById(id);
    if (!element)
        throw new Error(`Missing notification element: ${id}`);
    return element;
}
const panel = node('notification-panel');
const toggle = node('notification-toggle');
const enabled = node('email-enabled');
const recipient = node('email-recipient');
const cadence = node('email-cadence');
const save = node('email-save');
const retry = node('email-retry');
const testEmail = node('email-test');
const skillFilter = node('email-skill-filter');
const skillMode = node('email-skill-mode');
const internshipsOnly = node('email-internships');
for (const skill of SKILLS) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = String(skill.bit); input.checked = true;
    label.append(input, document.createTextNode(` ${skill.label}`));
    node('email-skills').append(label);
}
let dirty = false;
let busy = false;
let version = 0;
let loaded = false;
function message(text, error = false) {
    const notice = node('notification-message');
    notice.textContent = text;
    notice.classList.toggle('error', error);
    notice.hidden = !text;
}
function render(state, fill = false) {
    const issues = (state.counts.failed ?? 0) + (state.counts.uncertain ?? 0);
    testEmail.disabled = busy || !state.configured || !state.settings.enabled;
    node('notification-summary').textContent = state.settings.enabled
        ? !state.configured ? 'Email setup needed' : issues ? 'Email delivery issue' : 'Email enabled'
        : 'Notifications off';
    node('email-setup').hidden = state.configured;
    enabled.disabled = busy || (!state.configured && !state.settings.enabled);
    if (fill || (!dirty && !busy)) {
        enabled.checked = state.settings.enabled;
        recipient.value = state.settings.recipient;
        cadence.value = state.settings.cadence;
        node('email-scan-alerts').checked = state.settings.scanAlerts;
        skillFilter.checked = state.settings.skillFilter;
        skillMode.value = state.settings.skillMode;
        internshipsOnly.checked = state.settings.internshipsOnly;
        for (const input of node('email-skills').querySelectorAll('input')) input.checked = Boolean(state.settings.skillMask & Number(input.value));
    }
    const waiting = (state.counts.pending ?? 0) + (state.counts.sending ?? 0);
    node('email-status').textContent = `${state.queuedJobs} jobs awaiting an email · ${waiting} emails pending · ${state.counts.sent ?? 0} accepted by provider`;
    node('email-status').textContent += state.budget ? ` · Attempts: ${state.budget.dailyUsed}/${state.budget.dailyLimit} (24h), ${state.budget.monthlyUsed}/${state.budget.monthlyLimit} (31 days)${state.budget.resumeAt ? ` · Limit reached; queued until at least ${new Date(state.budget.resumeAt).toLocaleString()}` : ''}` : '';
    node('email-schedule').textContent = state.settings.enabled && state.settings.cadence === 'daily' && state.settings.nextDigestAt
        ? `Next digest: first source check after ${new Date(state.settings.nextDigestAt).toLocaleString()}.`
        : 'Emails are processed after automatic or manual source checks. Regular checks run at :00–:16; recovery checks run at :17–:33. Incomplete-scan warnings are separate from the daily digest.';
    retry.hidden = !state.settings.enabled || !state.configured || !state.history.some(item => item.canRetry);
    const history = state.history.map(item => {
        const row = document.createElement('li');
        const status = item.status === 'sent' ? 'Accepted by provider' : item.status;
        row.textContent = `${new Date(item.createdAt).toLocaleString()} · ${item.kind === 'scan_alert' ? 'Incomplete scan warning' : item.kind === 'test' ? 'Test email' : item.kind === 'digest' ? `Daily summary · ${item.jobCount} new jobs` : `${item.jobCount} jobs`} · ${status}${item.error ? ` — ${item.error}` : ''}`;
        return row;
    });
    node('email-history').replaceChildren(...history);
    node('email-history-empty').hidden = history.length > 0;
    loaded = true;
    save.disabled = busy;
}
async function refresh() {
    if (busy)
        return;
    const id = ++version;
    try {
        const response = await fetch('/api/notifications', { cache: 'no-store' });
        if (!response.ok)
            throw new Error('Could not load notification settings. Try opening settings again.');
        const state = await response.json();
        if (id !== version)
            return;
        render(state);
    }
    catch (error) {
        if (id === version) {
            node('notification-summary').textContent = 'Notification status unavailable';
            message(error instanceof Error ? error.message : 'Could not load settings.', true);
        }
    }
}
async function write(path, body) {
    if (busy)
        return;
    busy = true;
    version++;
    save.disabled = retry.disabled = enabled.disabled = testEmail.disabled = true;
    recipient.disabled = cadence.disabled = true;
    node('email-skill-settings').disabled = true;
    node('email-scan-alerts').disabled = true;
    message('Saving…');
    try {
        const response = await fetch(path, { method: body ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok)
            throw new Error(result.error || 'Could not save notification settings.');
        dirty = false;
        busy = false;
        render(result, true);
        message(body ? 'Notification settings saved.' : 'Email processing complete. Check delivery history and your inbox for the result.');
    }
    catch (error) {
        message(error instanceof Error ? error.message : 'Notification request failed.', true);
    }
    finally {
        busy = false;
        save.disabled = !loaded;
        retry.disabled = recipient.disabled = cadence.disabled = false;
        node('email-skill-settings').disabled = false;
        node('email-scan-alerts').disabled = false;
        void refresh();
    }
}
toggle.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden)
        void refresh();
});
node('notification-form').addEventListener('input', () => { dirty = true; });
node('notification-form').addEventListener('submit', event => {
    event.preventDefault();
    const skillMask = [...node('email-skills').querySelectorAll('input:checked')].reduce((mask, input) => mask | Number(input.value), 0);
    if (!skillMask) { message('Select at least one email skill.', true); return; }
    void write('/api/notifications', { scanAlerts: node('email-scan-alerts').checked, skillFilter: skillFilter.checked, skillMask, skillMode: skillMode.value, internshipsOnly: internshipsOnly.checked, enabled: enabled.checked, recipient: recipient.value.trim(), cadence: cadence.value });
});
retry.addEventListener('click', () => void write('/api/notifications/retry'));
testEmail.addEventListener('click', () => void write('/api/notifications/test'));
// Also update the small status bar when a manual source check finishes.
window.addEventListener('bay-jobs-checked', () => void refresh());
setInterval(() => { if (!document.hidden)
    void refresh(); }, 60_000);
void refresh();
export {};
