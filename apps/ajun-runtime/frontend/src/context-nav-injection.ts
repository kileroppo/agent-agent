const NAV_GROUPS: Record<string, Array<{ href: string; page: string; label: string; ownerOnly?: boolean }>> = {
    system: [
        { href: '#employees', page: 'employees', label: '员工编队' },
        { href: '#connections', page: 'connections', label: '账号接入', ownerOnly: true },
        { href: '#billing', page: 'billing', label: 'AI 成本账本', ownerOnly: true },
        { href: '#release', page: 'release', label: '版本管理', ownerOnly: true },
    ],
    tools: [
        { href: '#boom-monitor', page: 'boom-monitor', label: '爆款雷达' },
        { href: '#campaigns', page: 'campaigns', label: '发布活动' },
    ],
};

export function injectContextNavigation(): void {
    for (const [group, items] of Object.entries(NAV_GROUPS)) {
        const containers: any = document.querySelectorAll(`nav[data-nav-group="${group}"]`);
        for (const nav of containers) {
            nav.replaceChildren(...items.map((item: any): any => {
                const a: any = document.createElement('a');
                a.href = item.href;
                a.dataset.contextPage = item.page;
                a.textContent = item.label;
                if (item.ownerOnly) {
                    a.dataset.ownerOnly = '';
                    a.hidden = true;
                }
                return a;
            }));
        }
    }
}
