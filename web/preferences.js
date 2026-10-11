const panel = document.getElementById('search-preferences');
const form = document.getElementById('preferences-form');
const fields = document.getElementById('preferences-fields');
const cities = document.getElementById('preference-cities');
const levels = document.getElementById('preference-levels');
const broad = document.getElementById('preference-broad');
const remote = document.getElementById('preference-remote');
const keywords = document.getElementById('preference-keywords');
const excluded = document.getElementById('preference-excluded');
const message = document.getElementById('preferences-message');
const labels = { internship: 'Internships / co-ops', new_grad: 'New grad / entry level', experienced: 'Experienced', unspecified: 'Unspecified level' };
let loaded = false;
let busy = false;
function notice(text, error = false) {
    message.textContent = text;
    message.classList.toggle('error', error);
}
async function load() {
    if (loaded || busy) return;
    busy = true;
    try {
        const response = await fetch('/api/preferences', { cache: 'no-store' });
        if (!response.ok) throw new Error('Could not load preferences. Close and reopen this panel to retry.');
        const state = await response.json();
        cities.replaceChildren(...state.locations.map(city => new Option(city, city, false, state.preferences.locations.includes(city))));
        levels.replaceChildren(...state.experienceLevels.map(level => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox'; input.value = level; input.checked = state.preferences.experienceLevels.includes(level);
            label.append(input, document.createTextNode(labels[level]));
            return label;
        }));
        remote.checked = state.preferences.includeRemote;
        broad.checked = state.preferences.reviewBroadLocations;
        keywords.value = state.preferences.keywords.join(', ');
        excluded.value = state.preferences.excludedKeywords.join(', ');
        loaded = true;
        fields.disabled = false;
        notice('');
    } catch (error) { notice(error.message, true); }
    finally { busy = false; }
}
panel.addEventListener('toggle', () => { if (panel.open) void load(); });
document.getElementById('all-cities').addEventListener('click', () => {
    for (const option of cities.options) option.selected = true;
});
form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !loaded) return;
    busy = true;
    fields.disabled = true;
    const words = input => input.value.split(/[,，、;\r\n]+/).map(word => word.trim()).filter(Boolean);
    const preferences = { locations: [...cities.selectedOptions].map(option => option.value), includeRemote: remote.checked, reviewBroadLocations: broad.checked,
        experienceLevels: [...levels.querySelectorAll('input:checked')].map(input => input.value),
        keywords: words(keywords), excludedKeywords: words(excluded) };
    try {
        const response = await fetch('/api/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preferences) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not save preferences.');
        window.dispatchEvent(new Event('preferences-saved'));
        notice('Saved. Use “Check all sources” to apply these preferences.');
    } catch (error) { notice(error.message, true); }
    finally { busy = false; fields.disabled = false; }
});
