export function replaceChildrenPreservingDisclosureState(container: any, nodes: any): any {
    const currentNodes: any = [...container.childNodes];
    if (currentNodes.length === nodes.length
        && currentNodes.every((node: any, index: any): any => sameRenderedNode(node, nodes[index]))) {
        return false;
    }
    const openKeys: any = new Set([...container.querySelectorAll('details[data-disclosure-key]')]
        .filter((details: any): any => details.open)
        .map((details: any): any => details.dataset.disclosureKey));
    container.replaceChildren(...nodes);
    for (const details of container.querySelectorAll('details[data-disclosure-key]')) {
        details.open = openKeys.has(details.dataset.disclosureKey);
    }
    return true;
}
export function markSyncStarted(indicator: any, { background = false }: any = {}): any {
    if (background)
        return false;
    indicator.className = 'sync-indicator syncing';
    return true;
}
export function setTextIfChanged(element: any, text: any): any {
    if (element.textContent === text)
        return false;
    element.textContent = text;
    return true;
}
function sameRenderedNode(current: any, replacement: any): any {
    if (current.isEqualNode(replacement))
        return true;
    if (typeof current.cloneNode !== 'function' || typeof replacement.cloneNode !== 'function')
        return false;
    const currentClone: any = current.cloneNode(true);
    const replacementClone: any = replacement.cloneNode(true);
    clearDisclosureState(currentClone);
    clearDisclosureState(replacementClone);
    return currentClone.isEqualNode(replacementClone);
}
function clearDisclosureState(node: any): any {
    if (node.matches?.('details[data-disclosure-key]'))
        node.open = false;
    for (const details of node.querySelectorAll?.('details[data-disclosure-key]') || []) {
        details.open = false;
    }
}
