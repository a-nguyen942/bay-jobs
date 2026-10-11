const toggle = document.getElementById('theme-toggle');
function renderTheme() {
    const dark = document.documentElement.dataset.theme !== 'light';
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.title = dark ? 'Switch to light mode' : 'Switch to night mode';
}
toggle.addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('bay-jobs-theme', theme); } catch { /* Keep the toggle usable without storage. */ }
    renderTheme();
});
renderTheme();
