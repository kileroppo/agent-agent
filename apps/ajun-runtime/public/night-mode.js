export function initNightMode() {
    const toggle = document.querySelector('#night-mode-toggle');
    const html = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const stored = localStorage.getItem('ajun-night-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored === '1' || (!stored && prefersDark);
    applyTheme(isDark);
    toggle?.addEventListener('click', () => {
        const currentDark = html.classList.contains('night-mode') || (!html.classList.contains('light-mode') && prefersDark);
        const nextDark = !currentDark;
        localStorage.setItem('ajun-night-mode', nextDark ? '1' : '0');
        applyTheme(nextDark);
    });
    function applyTheme(dark) {
        if (dark) {
            html.classList.add('night-mode');
            html.classList.remove('light-mode');
            if (meta)
                meta.setAttribute('content', '#121a16');
        }
        else {
            html.classList.remove('night-mode');
            html.classList.add('light-mode');
            if (meta)
                meta.setAttribute('content', '#f6f7f2');
        }
    }
}
