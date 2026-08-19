const RAW_MARKER = Symbol('html-raw');
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[char]));
}
export function raw(value) {
    return { [RAW_MARKER]: true, value: String(value ?? '') };
}
export function html(strings, ...values) {
    let result = strings[0];
    for (let i = 0; i < values.length; i += 1) {
        const value = values[i];
        if (value != null && typeof value === 'object' && RAW_MARKER in value) {
            result += value.value;
        }
        else {
            result += escapeHtml(value);
        }
        result += strings[i + 1];
    }
    return result;
}
