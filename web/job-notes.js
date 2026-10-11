export function createJobNotes(inbox) {
    const form = document.getElementById('job-notes-form');
    const notes = document.getElementById('job-notes');
    const deadline = document.getElementById('job-deadline');
    const followUp = document.getElementById('job-follow-up');
    const save = document.getElementById('job-notes-save');
    const message = document.getElementById('job-notes-message');
    const drafts = new Map();
    let shownId = null;
    function render(job) {
        shownId = job?.id ?? null;
        if (!job) return;
        const draft = drafts.get(job.id);
        const values = draft ?? job;
        if (notes.value !== (values.notes ?? '')) notes.value = values.notes ?? '';
        if (followUp.value !== (values.followUpDate ?? '')) followUp.value = values.followUpDate ?? '';
        if (deadline.value !== (values.deadlineDate ?? '')) deadline.value = values.deadlineDate ?? '';
        notes.disabled = deadline.disabled = followUp.disabled = save.disabled = inbox.isSaving(job.id);
        message.textContent = draft ? 'Unsaved changes — kept while you browse, until this page closes.' : '';
    }
    form.addEventListener('input', () => {
        if (!shownId) return;
        drafts.set(shownId, { notes: notes.value, followUpDate: followUp.value || null, deadlineDate: deadline.value || null });
        message.textContent = 'Unsaved changes — kept while you browse, until this page closes.';
    });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const id = shownId;
        if (!id || inbox.isSaving(id)) return;
        const draft = { notes: notes.value, followUpDate: followUp.value || null, deadlineDate: deadline.value || null };
        drafts.set(id, draft);
        const saved = await inbox.update(id, draft);
        if (saved && drafts.get(id) === draft) drafts.delete(id);
        render(inbox.selected);
        if (shownId === id) message.textContent = saved ? 'Notes and dates saved.' : 'Not saved. Your draft is still here; try again.';
    });
    return { render };
}
