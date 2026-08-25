export function initNightMode(): any {
    const toggle: any = document.querySelector('#night-mode-toggle');
    const html: any = document.documentElement;
    const meta: any = document.querySelector('meta[name="theme-color"]');
    const stored: any = localStorage.getItem('ajun-night-mode');
    const prefersDark: any = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const enabled: any = stored === '1' || (!stored && prefersDark);

    if (enabled) {
        html.classList.add('night-mode');
        if (meta) meta.setAttribute('content', '#121a16');
        toggle?.querySelector('.moon')?.removeAttribute('hidden');
        toggle?.querySelector('.sun')?.setAttribute('hidden', '');
    }

    toggle?.addEventListener('click', (): any => {
        const isNight: any = html.classList.toggle('night-mode');
        localStorage.setItem('ajun-night-mode', isNight ? '1' : '0');
        if (meta) meta.setAttribute('content', isNight ? '#121a16' : '#f6f7f2');
        const moonIcon: any = toggle.querySelector('.moon');
        const sunIcon: any = toggle.querySelector('.sun');
        if (isNight) {
            moonIcon?.setAttribute('hidden', '');
            sunIcon?.removeAttribute('hidden');
        } else {
            moonIcon?.removeAttribute('hidden');
            sunIcon?.setAttribute('hidden', '');
        }
    });
}
