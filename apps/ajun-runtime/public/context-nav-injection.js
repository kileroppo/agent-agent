const NAV_GROUPS = {
    system: [
        { href: '#release', page: 'release', label: '版本管理', ownerOnly: true },
        { href: '#employees', page: 'employees', label: '员工编队' },
        { href: '#connections', page: 'connections', label: '账号接入', ownerOnly: true },
        { href: '#billing', page: 'billing', label: 'AI 成本账本', ownerOnly: true },
    ],
    tools: [
        { href: '#boom-monitor', page: 'boom-monitor', label: '爆款雷达' },
        { href: '#campaigns', page: 'campaigns', label: '发布活动' },
    ],
};
export function injectContextNavigation() {
    for (const [group, items] of Object.entries(NAV_GROUPS)) {
        const containers = document.querySelectorAll(`nav[data-nav-group="${group}"]`);
        for (const nav of containers) {
            nav.replaceChildren(...items.map((item) => {
                const a = document.createElement('a');
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
