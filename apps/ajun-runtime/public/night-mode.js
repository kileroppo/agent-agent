export function initNightMode() {
    const toggle = document.querySelector('#night-mode-toggle');
    const html = document.documentElement;
    const meta = document.querySelector('meta[name="theme-color"]');
    const stored = localStorage.getItem('ajun-night-mode');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const enabled = stored === '1' || (!stored && prefersDark);
    if (enabled) {
        html.classList.add('night-mode');
        if (meta)
            meta.setAttribute('content', '#121a16');
        toggle?.querySelector('.moon')?.removeAttribute('hidden');
        toggle?.querySelector('.sun')?.setAttribute('hidden', '');
    }
    toggle?.addEventListener('click', () => {
        const isNight = html.classList.toggle('night-mode');
        localStorage.setItem('ajun-night-mode', isNight ? '1' : '0');
        if (meta)
            meta.setAttribute('content', isNight ? '#121a16' : '#f6f7f2');
        const moonIcon = toggle.querySelector('.moon');
        const sunIcon = toggle.querySelector('.sun');
        if (isNight) {
            moonIcon?.setAttribute('hidden', '');
            sunIcon?.removeAttribute('hidden');
        }
        else {
            moonIcon?.removeAttribute('hidden');
            sunIcon?.setAttribute('hidden', '');
        }
    });
}
