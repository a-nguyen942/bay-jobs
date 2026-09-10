/** Small data controller shared by DOM events and polling. No UI framework. */
export function createInbox(onChange, request = fetch) {
    let data = null;
    let filters = { view: 'all', query: '', page: 1 };
    let selected = null;
    let loading = false;
    let loadError = '';
    let saveError = '';
    let checkError = '';
    let checking = false;
    let checkMessage = '';
    let refreshAfterWrites = false;
    let revision = 0;
    let refreshId = 0;
    const pending = new Set();
    return {
        get data() { return data; },
        get filters() { return { ...filters }; },
        get selected() { return selected; },
        get loading() { return loading; },
        select(job) { selected = job; onChange(); },
        async navigate(change) {
            filters = { ...filters, ...change, page: ('query' in change || 'view' in change) ? 1 : change.page ?? filters.page };
            revision++;
            selected = null;
            data = null;
            loadError = '';
            loading = true;
            onChange();
            await this.refresh();
        },
        get error() { return saveError || checkError || loadError; },
        get checking() { return checking; },
        get checkMessage() { return checkMessage; },
        isSaving(id) { return pending.has(id); },
        async refresh() {
            if (pending.size) {
                refreshAfterWrites = true;
                return;
            }
            const atStart = revision;
            const id = ++refreshId;
            loading = true;
            onChange();
            try {
                const params = new URLSearchParams({ view: filters.view, q: filters.query, page: String(filters.page) });
                const response = await request(`/api/jobs?${params}`, { cache: 'no-store' });
                if (!response.ok)
                    throw new Error('Could not load your inbox. Check that the local database is initialized, then try again.');
                const payload = await response.json();
                // A write or newer refresh makes this snapshot obsolete.
                if (revision !== atStart || id !== refreshId)
                    return;
                // Removing the last row on the last page should take us to the new last page.
                if (payload.pagination.page > payload.pagination.pages) {
                    filters.page = payload.pagination.pages;
                    await this.refresh();
                    return;
                }
                data = payload;
                if (selected)
                    selected = payload.jobs.find(job => job.id === selected?.id) ?? selected;
                loadError = '';
            }
            catch (error) {
                if (revision !== atStart || id !== refreshId)
                    return;
                loadError = error instanceof Error ? error.message : 'Could not load your inbox.';
            }
            loading = false;
            onChange();
        },
        async check() {
            if (checking)
                return;
            checking = true;
            checkError = '';
            checkMessage = 'Checking job sources…';
            onChange();
            try {
                const response = await request('/api/check', { method: 'POST' });
                if (!response.ok) {
                    if (response.status === 409)
                        throw new Error('A source check is already running. Try again shortly.');
                    throw new Error('Could not check sources. Please try again.');
                }
                const { report } = await response.json();
                const added = report.reduce((count, source) => count + source.inserted, 0);
                const matched = report.reduce((count, source) => count + source.matched, 0);
                const failures = report.filter(source => source.error);
                checkMessage = report.length ? `${added} new ${added === 1 ? 'job' : 'jobs'} added · ${matched} matching listings checked.` : 'No job sources configured.';
                if (failures.length)
                    checkError = `${failures.length} source check(s) failed. Some listings may be missing; review the source errors and try again.`;
                await this.refresh();
            }
            catch (error) {
                checkMessage = '';
                checkError = error instanceof Error ? error.message : 'Could not check sources.';
            }
            finally {
                checking = false;
                onChange();
            }
        },
        async update(jobId, patch) {
            if (pending.has(jobId))
                return;
            if (loading)
                refreshAfterWrites = true;
            pending.add(jobId);
            revision++;
            saveError = '';
            onChange();
            try {
                const response = await request(`/api/jobs/${encodeURIComponent(jobId)}`, {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
                });
                if (!response.ok)
                    throw new Error('Your change was not saved. Please try the change again.');
                const updated = await response.json();
                if (data)
                    data = { ...data, jobs: data.jobs.map(job => job.id === jobId ? updated : job) };
                if (selected?.id === jobId)
                    selected = updated;
                refreshAfterWrites = true;
            }
            catch (error) {
                saveError = error instanceof Error ? error.message : 'Your change was not saved.';
            }
            finally {
                revision++;
                pending.delete(jobId);
                onChange();
                if (!pending.size && refreshAfterWrites) {
                    refreshAfterWrites = false;
                    await this.refresh();
                }
            }
        },
    };
}
