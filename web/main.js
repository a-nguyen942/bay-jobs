import { renderCpuSafety } from './cpu-safety.js';
import './styles.css';
import './theme.js';
import './notifications.js';
import './preferences.js';
import './coverage.js';
import { SKILLS } from '../lib/skills.js';
import { APPLICATION_STATUSES } from '../lib/constants.js';
import { createInbox } from './inbox.js';
import { createSourcePanel } from './sources.js';
import { renderScanSummary } from './scan-summary.js';
import { createJobNotes } from './job-notes.js';
import { localDate } from '../lib/dates.js';
let searchTimer;
const date = (value) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const foundTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
function element(id) {
    const node = document.getElementById(id);
    if (!node)
        throw new Error(`Missing inbox element: ${id}`);
    return node;
}
function textNode(tag, text, className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    return node;
}
const inbox = createInbox(render);
window.addEventListener('coverage-imported', () => { void inbox.refresh(); });
const jobNotes = createJobNotes(inbox);
const sourcePanel = createSourcePanel(async job => {
    clearTimeout(searchTimer);
    element('search').value = '';
    await inbox.navigate({ view: job.applicationStatus === 'archived' ? 'archived' : 'all', query: '' });
    inbox.select(job);
});
const detail = element('detail');
const parking = element('detail-parking');
let selectedIndex = 0;
const status = element('application-status');
status.replaceChildren(...APPLICATION_STATUSES.map(value => new Option(value.charAt(0).toUpperCase() + value.slice(1), value)));
function jobRow(job) {
    const row = document.createElement('tr');
    row.classList.add('job-row');
    row.classList.toggle('selected', inbox.selected?.id === job.id);
    const cell = document.createElement('td');
    const button = textNode('button', '', 'job-button');
    button.dataset.jobId = job.id;
    button.setAttribute('aria-expanded', String(inbox.selected?.id === job.id));
    button.setAttribute('aria-controls', 'detail');
    const dot = textNode('span', '', job.seenAt ? 'read-dot' : 'unread-dot');
    dot.setAttribute('aria-label', job.seenAt ? 'Seen' : 'Unseen');
    const label = document.createElement('span');
    const company = textNode('span', job.company, 'company');
    if (job.isDemo)
        company.append(textNode('span', 'Demo', 'demo-tag'));
    label.append(textNode('strong', `${job.isFavorite ? '★ ' : ''}${job.title}`), company);
    const tags = SKILLS.filter(skill => (job.skillMask ?? 0) & skill.bit).map(skill => skill.label);
    label.append(textNode('span', tags.length ? tags.join(' · ') : 'Skills not specified', 'skill-tags'));
    const chevron = textNode('span', inbox.selected?.id === job.id ? '−' : '+', 'expand-mark');
    chevron.setAttribute('aria-hidden', 'true');
    button.append(dot, label, chevron);
    button.addEventListener('click', () => {
        if (inbox.selected?.id === job.id) {
            inbox.select(null);
            return;
        }
        selectedIndex = inbox.data?.jobs.findIndex(item => item.id === job.id) ?? 0;
        inbox.select(job);
        if (!job.seenAt)
            void inbox.update(job.id, { seen: true });
    });
    row.addEventListener('click', event => {
        if (!(event.target instanceof Element) || !event.target.closest('button'))
            button.click();
    });
    cell.append(button);
    const found = document.createElement('td');
    const time = textNode('time', foundTime.format(new Date(job.firstFoundAt)));
    time.dateTime = job.firstFoundAt;
    found.append(time);
    const application = document.createElement('td');
    application.append(textNode('span', job.applicationStatus, `badge ${job.applicationStatus}`));
    if (job.closedAt) application.append(textNode('span', 'Possibly closed', 'badge possibly-closed'));
    if (job.deadlineDate) application.append(textNode('span', `${job.deadlineDate < localDate() ? 'Deadline passed' : job.deadlineDate === localDate() ? 'Deadline today' : 'Apply by'} · ${job.deadlineDate}`, 'badge follow-up-badge'));
    if (job.followUpDate) application.append(textNode('span', `${job.followUpDate < localDate() ? 'Overdue' : job.followUpDate === localDate() ? 'Due today' : 'Follow up'} · ${job.followUpDate}`, 'badge follow-up-badge'));
    row.append(cell, textNode('td', job.location), found, application);
    return row;
}
function render() {
    const { data, error } = inbox;
    const check = element('check');
    check.disabled = inbox.checking;
    check.textContent = inbox.checking ? 'Checking all sources…' : 'Check all sources';
    element('check-result').textContent = inbox.checkMessage;
    element('check-result').hidden = !inbox.checkMessage;
    const jobs = data?.jobs ?? [];
    const visible = [...jobs];
    const selected = inbox.selected;
    jobNotes.render(selected);
    const selectedIsFilteredOut = Boolean(selected && !jobs.some(job => job.id === selected.id));
    // Keep an opened unseen job anchored here after its automatic seen update.
    if (selected && selectedIsFilteredOut)
        visible.splice(Math.max(0, Math.min(selectedIndex, visible.length)), 0, selected);
    else if (selected)
        selectedIndex = visible.findIndex(job => job.id === selected.id);
    const { view, query } = inbox.filters;
    element('listing-order').textContent = inbox.filters.sort === 'deadline' || view === 'deadlines' ? 'Earliest deadline first' : inbox.filters.sort === 'importance' ? 'Internships → skill matches → newest' : view === 'follow_up' ? 'Earliest follow-up first' : 'Newest discovered first';
    const pagination = data?.pagination;
    const monitor = data?.monitor;
    sourcePanel.render(monitor?.sources);
    renderCpuSafety(monitor?.safety, Boolean(error));
    check.disabled = inbox.checking || Boolean(monitor?.safety?.paused) || (monitor?.safety?.manualStarts >= monitor?.safety?.manualDailyLimit);
    renderScanSummary(monitor?.scan, Boolean(error));
    element('monitor').textContent = monitor?.sourceCount
        ? `${monitor.sourceCount} source(s) configured · ${monitor.lastCheckedAt ? `Last checked ${new Date(monitor.lastCheckedAt).toLocaleString()}` : 'Waiting for first check'}`
        : data ? 'Monitoring not connected yet' : 'Monitor status unavailable';
    element('demo-note').hidden = !data?.summary.demo;
    element('source-errors').replaceChildren(...(monitor?.errors ?? []).map(source => textNode('p', `Could not check ${source.sourceId}: ${source.error}`, 'error')));
    element('error').hidden = !error;
    element('error-message').textContent = error;
    element('review-count').textContent = String(data?.summary.needsReview ?? 0);
    element('review-count').hidden = !data?.summary.needsReview;
    element('review-note').hidden = inbox.filters.view !== 'review';
    element('skill-mode').disabled = inbox.filters.view === 'review';
    const unseen = data?.summary.unseen ?? 0;
    element('unseen-count').textContent = String(unseen);
    element('unseen-count').hidden = unseen === 0;
    element('views').querySelectorAll('button').forEach(button => {
        const active = button.dataset.view === view;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
    element('listing').setAttribute('aria-busy', String(inbox.loading));
    element('total').textContent = pagination ? `${pagination.total} ${pagination.total === 1 ? 'opportunity' : 'opportunities'}` : 'Loading…';
    element('pagination').hidden = !pagination || pagination.pages <= 1;
    element('page-label').textContent = pagination ? `Page ${pagination.page} of ${pagination.pages}` : '';
    element('previous-page').disabled = inbox.loading || !pagination || pagination.page <= 1;
    element('next-page').disabled = inbox.loading || !pagination || pagination.page >= pagination.pages;
    const extra = element('more-views');
    extra.value = ['considering', 'interviewing', 'rejected'].includes(view) ? view : '';
    element('table').hidden = !visible.length;
    const empty = element('empty');
    empty.hidden = Boolean(visible.length);
    if (!data)
        empty.textContent = error ? 'Your inbox could not be loaded.' : 'Loading your inbox…';
    else
        empty.replaceChildren(textNode('div', '＋', 'empty-mark'), textNode('h2', query ? 'No matching jobs' : data.summary.total ? 'All clear here' : 'Your next opportunity starts here.'), textNode('p', query ? 'Try a different role, company, or location.' : data.summary.total ? 'Try another view or relax the skill and internship filters.' : monitor?.sourceCount ? 'Choose “Check all sources” to collect matching Bay Area roles.' : 'Connect a job source to start collecting Bay Area roles. New listings will appear here.'));
    // Move the existing controls, retaining their event listeners and keyboard focus.
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedJob = focused?.dataset.jobId;
    const focusInDetail = focused && detail.contains(focused);
    parking.append(detail);
    const rendered = visible.flatMap(job => {
        const row = jobRow(job);
        if (job.id !== selected?.id)
            return [row];
        const expansion = document.createElement('tr');
        expansion.className = 'detail-row';
        const cell = document.createElement('td');
        cell.colSpan = 4;
        cell.append(detail);
        expansion.append(cell);
        return [row, expansion];
    });
    element('rows').replaceChildren(...rendered);
    const job = selected;
    detail.hidden = !job;
    element('filtered-note').hidden = !selectedIsFilteredOut;
    if (focusedJob) {
        const next = [...element('rows').querySelectorAll('button')].find(button => button.dataset.jobId === focusedJob);
        (next ?? element('search')).focus({ preventScroll: true });
    }
    else if (focusInDetail && job)
        focused.focus({ preventScroll: true });
    if (!job)
        return;
    const selectedSkills = SKILLS.filter(skill => inbox.filters.skills & skill.bit);
    const matched = selectedSkills.filter(skill => (job.skillMask ?? 0) & skill.bit);
    const missing = selectedSkills.filter(skill => !((job.skillMask ?? 0) & skill.bit));
    element('match-explanation').textContent = selectedSkills.length
        ? `${matched.length} of ${selectedSkills.length} selected skill groups mentioned. ${matched.length ? `Matches: ${matched.map(skill => skill.label).join(', ')}.` : 'No selected skills detected.'}${missing.length ? ` Not detected: ${missing.map(skill => skill.label).join(', ')}.` : ''} Based on available title and description text; a mention is not proof of a requirement, and missing text is not proof a skill is irrelevant.`
        : 'Select skills above to see how this listing matches. Matches use available title and description text.';
    const favorite = element('toggle-favorite');
    favorite.textContent = job.isFavorite ? '★ Favorited' : '☆ Add to favorites';
    favorite.setAttribute('aria-pressed', String(job.isFavorite));
    favorite.disabled = inbox.isSaving(job.id);
    element('detail-company').textContent = job.company;
    element('detail-title').textContent = job.title;
    element('detail-location').textContent = job.location;
    element('detail-source').textContent = job.sourceLabel;
    element('detail-found').textContent = foundTime.format(new Date(job.firstFoundAt));
    element('detail-posted').textContent = job.postedAt ? date(job.postedAt) : 'Not provided';
    element('detail-availability').hidden = !job.closedAt;
    element('detail-availability').textContent = job.closedAt
        ? `Possibly closed · flagged ${date(job.closedAt)}. Missing from every previously observed source for at least two successful checks. Verify on the employer’s website; your application status is unchanged.` : '';
    status.value = job.applicationStatus;
    status.disabled = inbox.isSaving(job.id);
    const seen = element('toggle-seen');
    seen.textContent = `Mark as ${job.seenAt ? 'unseen' : 'seen'}`;
    seen.disabled = inbox.isSaving(job.id);
    element('detail-demo').hidden = !job.isDemo;
    const apply = element('apply');
    apply.removeAttribute('href');
    apply.hidden = true;
    if (!job.isDemo) {
        try {
            const url = new URL(job.canonicalUrl);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
                apply.href = url.toString();
                apply.hidden = false;
            }
        }
        catch { /* Malformed source links must never become executable links. */ }
    }
}
for (const skill of SKILLS) {
    const label = textNode('label', '');
    const input = document.createElement('input');
    input.type = 'checkbox'; input.value = String(skill.bit); input.checked = true;
    label.append(input, document.createTextNode(` ${skill.label}`));
    element('skill-choices').append(label);
}
function changeSkills() {
    clearTimeout(searchTimer);
    const skills = [...element('skill-choices').querySelectorAll('input:checked')].reduce((mask, input) => mask | Number(input.value), 0);
    void inbox.navigate({ skills, sort: element('sort-order').value, skillMode: element('skill-mode').value,
        internships: element('internships-only').checked, hideClosed: element('hide-closed').checked, query: element('search').value });
}
for (const id of ['skill-choices', 'sort-order', 'skill-mode', 'internships-only', 'hide-closed']) element(id).addEventListener('change', changeSkills);
element('refresh').addEventListener('click', () => void inbox.refresh());
element('check').addEventListener('click', async () => { await inbox.check(); window.dispatchEvent(new Event('bay-jobs-checked')); });
element('retry').addEventListener('click', () => void inbox.refresh());
element('search').addEventListener('input', event => {
    const query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void inbox.navigate({ query }), 250);
});
function changeView(view) {
    clearTimeout(searchTimer);
    void inbox.navigate({ view, query: element('search').value });
}
element('more-views').addEventListener('change', event => {
    const value = event.target.value;
    if (value)
        changeView(value);
});
element('previous-page').addEventListener('click', () => void inbox.navigate({ page: inbox.filters.page - 1 }));
element('next-page').addEventListener('click', () => void inbox.navigate({ page: inbox.filters.page + 1 }));
element('views').querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => { changeView(button.dataset.view); });
});
element('close').addEventListener('click', () => {
    const previousId = inbox.selected?.id;
    inbox.select(null);
    const button = [...element('rows').querySelectorAll('button')].find(item => item.dataset.jobId === previousId);
    (button ?? element('search')).focus();
});
status.addEventListener('change', () => { if (inbox.selected)
    void inbox.update(inbox.selected.id, { applicationStatus: status.value }); });
element('toggle-favorite').addEventListener('click', () => {
    if (inbox.selected) void inbox.update(inbox.selected.id, { isFavorite: !inbox.selected.isFavorite });
});
element('toggle-seen').addEventListener('click', () => {
    const job = inbox.selected;
    if (job)
        void inbox.update(job.id, { seen: !job.seenAt });
});
setInterval(() => { if (!document.hidden)
    void inbox.refresh(); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden)
    void inbox.refresh(); });
void inbox.refresh();
