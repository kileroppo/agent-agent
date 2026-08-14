export function replaceChildrenPreservingDisclosureState(container, nodes) {
    const currentNodes = [...container.childNodes];
    if (currentNodes.length === nodes.length
        && currentNodes.every((node, index) => sameRenderedNode(node, nodes[index]))) {
        return false;
    }
    const openKeys = new Set([...container.querySelectorAll('details[data-disclosure-key]')]
        .filter((details) => details.open)
        .map((details) => details.dataset.disclosureKey));
    container.replaceChildren(...nodes);
    for (const details of container.querySelectorAll('details[data-disclosure-key]')) {
        details.open = openKeys.has(details.dataset.disclosureKey);
    }
    return true;
}
export function markSyncStarted(indicator, { background = false } = {}) {
    if (background)
        return false;
    indicator.className = 'sync-indicator syncing';
    return true;
}
export function setTextIfChanged(element, text) {
    if (element.textContent === text)
        return false;
    element.textContent = text;
    return true;
}
function sameRenderedNode(current, replacement) {
    if (current.isEqualNode(replacement))
        return true;
    if (typeof current.cloneNode !== 'function' || typeof replacement.cloneNode !== 'function')
        return false;
    const currentClone = current.cloneNode(true);
    const replacementClone = replacement.cloneNode(true);
    clearDisclosureState(currentClone);
    clearDisclosureState(replacementClone);
    return currentClone.isEqualNode(replacementClone);
}
function clearDisclosureState(node) {
    if (node.matches?.('details[data-disclosure-key]'))
        node.open = false;
    for (const details of node.querySelectorAll?.('details[data-disclosure-key]') || []) {
        details.open = false;
    }
}
